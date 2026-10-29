#!/usr/bin/env node
// Project memory: decisions, budgets' reasons, known slop, past failures, conventions and false positives, each
// anchored to code so it follows refactors. One JSON file per entry under <repo>/.jstack/memory/entries/, so parallel
// branches and trains merge without conflicts; or, with JSTACK_MEMORY_DIR / `git config jstack.memoryDir`, under one
// folder outside the repo that every worktree shares (location.mjs). Writes are atomic (temp file + rename), and a new
// entry never overwrites another agent's (hard link, fails on an existing id), so parallel agents can write at once.
// This script is the only writer: every write is schema-checked and secret-scanned (a hit is refused, exit 2); `lint`
// catches hand edits of the folder (schema and secrets).
//
//   node memory.mjs init
//   (kind preference: explanation preferences for /unslop:explain, written by tools/unslop/explain.mjs prefer)
//   node memory.mjs add --kind decision --title "..." [--domain a,b] [--anchor path[#symbol]]... [--guard path] [--body "..."]
//   node memory.mjs query [--paths a,b] [--domains x,y] [--kinds k] [--all] [--json]
//   node memory.mjs show <id>
//   node memory.mjs check [--changed --base <ref>] [--json]
//   node memory.mjs reanchor <id> (--auto | --accept | --to path#symbol [--also path#symbol]...)
//   node memory.mjs retire <id> --reason "..."
//   node memory.mjs lint | export | budgets
//   node memory.mjs where [--json|--tsv] where entries live (repo or external) and which setting chose it
// Exit codes: 0 ok, 1 check found problems or lint failed, 2 refused (secret, schema, usage).
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { scanFields } from './secrets.mjs'
import { makeAnchor, resolveAnchor, splitRef, git, isCommitId, isSafeRelPath } from './anchors.mjs'
import { memoryLocation } from './location.mjs'

const KINDS = ['decision', 'budget-rationale', 'known-slop', 'failure', 'convention', 'false-positive', 'preference']
const PREF_LEVELS = ['short', 'full']
const STATUSES = { 'known-slop': ['open', 'fixed', 'waived'], default: ['active', 'retired'] }
const LIMITS = { title: 160, body: 2000, humanQuote: 300, lesson: 600 }
const JSTACK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

class Refusal extends Error {}

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { out._.push(a); continue }
    const key = a.slice(2)
    const next = argv[i + 1]
    const val = next === undefined || next.startsWith('--') ? true : (i++, next)
    if (out[key] === undefined) out[key] = val
    else out[key] = [].concat(out[key], val)
  }
  return out
}

const list = v => (v === undefined || v === true ? [] : [].concat(v).flatMap(x => String(x).split(',')).map(s => s.trim()).filter(Boolean))

function repoRoot(opts) {
  if (opts.repo) return path.resolve(opts.repo)
  const r = git(process.cwd(), ['rev-parse', '--show-toplevel'])
  return r.ok ? path.resolve(r.out.trim()) : process.cwd()
}

const entriesDir = repo => memoryLocation(repo).entries

function newId(now = new Date()) {
  const p = n => String(n).padStart(2, '0')
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  const rand = [...crypto.randomBytes(6)].map(b => alphabet[b & 31]).join('')
  return `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}-${rand}`
}

function loadEntries(repo) {
  const dir = entriesDir(repo)
  let files = []
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')) } catch { return [] }
  return files.map(f => {
    try { return { ...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')), _file: f } } catch (e) { return { _file: f, _error: String(e.message) } }
  })
}

function getEntry(repo, id) {
  const e = loadEntries(repo).find(x => x.id === id)
  if (!e) throw new Refusal(`no memory entry ${id}`)
  return e
}

// Schema problems as strings; empty when valid.
function validate(entry) {
  const errs = []
  if (!/^\d{8}-\d{4}-[a-z2-7]{6}$/.test(entry.id ?? '')) errs.push('id: expected yyyymmdd-hhmm-<6 base32>')
  if (!KINDS.includes(entry.kind)) errs.push(`kind: one of ${KINDS.join(', ')}`)
  const statuses = STATUSES[entry.kind] ?? STATUSES.default
  if (!statuses.includes(entry.status)) errs.push(`status: one of ${statuses.join(', ')} for ${entry.kind}`)
  if (!entry.title || typeof entry.title !== 'string') errs.push('title: required')
  for (const [k, n] of Object.entries(LIMITS)) if (typeof entry[k] === 'string' && entry[k].length > n) errs.push(`${k}: at most ${n} characters`)
  if (!Array.isArray(entry.domains)) errs.push('domains: array')
  if (!Array.isArray(entry.anchors)) errs.push('anchors: array')
  else entry.anchors.forEach((a, i) => {
    if (!a?.path) errs.push(`anchors[${i}].path: required`)
    else if (!isSafeRelPath(a.path)) errs.push(`anchors[${i}].path: repo-relative only (no absolute path, no '..', no leading '-')`)
    if (a?.commit != null && !isCommitId(a.commit)) errs.push(`anchors[${i}].commit: 7-40 lowercase hex characters`)
  })
  if (entry.kind === 'known-slop' && entry.status === 'waived' && !entry.waiver?.reason) errs.push('waiver.reason: required for a waived known-slop')
  if (entry.kind === 'preference') {
    const pr = entry.prefs
    if (!pr || typeof pr !== 'object') errs.push('prefs: required for a preference')
    else {
      if (pr.level != null && !PREF_LEVELS.includes(pr.level)) errs.push(`prefs.level: one of ${PREF_LEVELS.join(', ')}`)
      for (const k of ['mute', 'unmute']) if (pr[k] != null && !(Array.isArray(pr[k]) && pr[k].every(x => typeof x === 'string' && /^[\w.-]{1,80}$/.test(x)))) errs.push(`prefs.${k}: array of rule ids`)
    }
  }
  if (!entry.created) errs.push('created: required')
  return errs
}

class IdTaken extends Error {}

// Readers only list *.json, so they never see the temp file, and the rename swaps the whole file at once.
// create: hard link instead of rename, which fails when the id exists, so two agents never overwrite each other.
function writeEntry(repo, entry, { create = false } = {}) {
  const clean = Object.fromEntries(Object.entries(entry).filter(([k]) => !k.startsWith('_')))
  const errs = validate(clean)
  if (errs.length) throw new Refusal(`refused: ${errs.join('; ')}`)
  const hits = scanFields(clean)
  if (hits.length) throw new Refusal(`refused: possible secret in ${hits.map(h => `${h.field} (${h.detector})`).join(', ')}. Memory never stores secrets; reference them by name.`)
  const dir = entriesDir(repo)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${clean.id}.json`)
  const tmp = path.join(dir, `.${clean.id}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2) + '\n')
  try {
    if (create) {
      try { fs.linkSync(tmp, file) } catch (e) { if (e.code === 'EEXIST') throw new IdTaken(clean.id); throw e }
    } else renameRetry(tmp, file)
  } finally {
    fs.rmSync(tmp, { force: true })
  }
  return file
}

// Windows refuses a rename over a file another process has open for a moment (EPERM/EBUSY/EACCES): retry briefly.
function renameRetry(from, to, tries = 20) {
  for (let i = 1; ; i++) {
    try { fs.renameSync(from, to); return } catch (e) {
      if (i >= tries || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * i)
    }
  }
}

const DEFAULT_UNSLOP = {
  enabled: true,
  domains: 'auto',
  gate: { mode: 'warn', blockSeverities: ['high'], maxSeconds: 60 },
  confirm: { maxCandidates: 25, maxAgents: 4, timeboxMinPerCandidate: 15 },
  rules: {},
  waivers: [],
  extraQuestions: [],
  extraRules: [],
  houseRules: { bannedWords: [], jargon: [] },
  paths: { ignore: [] },
}

function init(repo) {
  const j = path.join(repo, '.jstack')
  const loc = memoryLocation(repo)
  const made = []
  const put = (rel, content, root = j) => {
    const f = path.join(root, rel)
    if (fs.existsSync(f)) return
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, content)
    made.push(loc.external && root === loc.dir ? f.replace(/\\/g, '/') : path.relative(repo, f).replace(/\\/g, '/'))
  }
  put('unslop.json', JSON.stringify(DEFAULT_UNSLOP, null, 2) + '\n')
  put('budgets.json', JSON.stringify({ version: 1, budgets: {} }, null, 2) + '\n')
  put('.gitignore', 'local/\nunslop/runs/\n')
  put('entries/.gitkeep', '', loc.dir)
  put('README.md', [
    '# Project memory',
    '',
    'Written by jstack `tools/memory/memory.mjs`, one JSON file per entry in `entries/`. Do not edit by hand: the tool',
    'checks the schema and refuses secrets, and `memory.mjs lint` flags anything written here by hand.',
    '',
    '- Read: `node <jstack>/tools/memory/memory.mjs query --paths <files>` or `show <id>`.',
    '- Write: `memory.mjs add --kind decision|budget-rationale|known-slop|failure|convention|false-positive ...`.',
    '- After a refactor: `memory.mjs check --changed --base <ref>`, then `reanchor` or `retire` what it reports.',
    '',
  ].join('\n'), loc.dir)
  return made
}

function add(repo, o) {
  const kind = o.kind
  const now = new Date().toISOString()
  const anchors = []
  for (const ref of list(o.anchor)) anchors.push(makeAnchor(repo, ref, { role: 'subject' }))
  for (const ref of list(o.guard)) anchors.push(makeAnchor(repo, ref, { role: 'guard' }))
  const entry = {
    id: newId(),
    kind,
    status: o.status && o.status !== true ? o.status : (kind === 'known-slop' ? 'open' : 'active'),
    title: o.title === true ? '' : o.title,
    domains: list(o.domain ?? o.domains),
    anchors,
    evidence: o['evidence-test'] || o['evidence-run'] ? { test: o['evidence-test'] ?? null, run: o['evidence-run'] ?? null } : null,
    rule: o.rule ?? null,
    fingerprint: o.fingerprint ?? null,
    lesson: o.lesson ?? null,
    preflightProposal: o['preflight-proposal'] ?? null,
    source: { by: o.by ?? 'agent', session: o.session ?? null, humanQuote: o.quote ?? null },
    created: now,
    updated: now,
    reviewBy: o['review-by'] ?? null,
    supersedes: list(o.supersedes),
    links: list(o.link),
    body: o['body-file'] ? fs.readFileSync(o['body-file'], 'utf8') : (o.body ?? ''),
  }
  if (kind === 'known-slop' && entry.status === 'waived') entry.waiver = { reason: o['waiver-reason'] ?? null, expires: o['waiver-expires'] ?? null }
  if (entry.source.humanQuote) entry.humanQuote = entry.source.humanQuote
  createEntry(repo, entry)
  return entry
}

// A new entry under a fresh id; on the (rare) clash with another agent's id, draw a new one.
function createEntry(repo, entry) {
  for (let i = 0; ; i++) {
    try { return writeEntry(repo, entry, { create: true }) } catch (e) {
      if (!(e instanceof IdTaken) || i >= 8) throw e
      entry.id = newId()
    }
  }
}

// Entries related to paths (exact file 3, same folder 2) or domains (1), newest first within a score.
function query(repo, { paths = [], domains = [], kinds = [], all = false } = {}) {
  const ps = paths.map(p => p.replace(/\\/g, '/'))
  const scored = []
  for (const e of loadEntries(repo)) {
    if (e._error) continue
    if (!all && (e.status === 'retired')) continue
    if (kinds.length && !kinds.includes(e.kind)) continue
    let score = 0
    for (const a of e.anchors ?? []) {
      for (const p of ps) {
        if (a.path === p) score = Math.max(score, 3)
        else if (path.posix.dirname(a.path) === path.posix.dirname(p)) score = Math.max(score, 2)
      }
    }
    if ((e.domains ?? []).some(d => domains.includes(d))) score = Math.max(score, 1)
    if (!ps.length && !domains.length) score = 1
    if (score) scored.push({ e, score })
  }
  scored.sort((a, b) => b.score - a.score || String(b.e.created).localeCompare(String(a.e.created)))
  return scored.map(({ e, score }) => ({ entry: e, score, anchors: (e.anchors ?? []).map(a => ({ ref: `${a.path}${a.symbol ? '#' + a.symbol : ''}`, role: a.role, ...pick(resolveAnchor(repo, a)) })) }))
}

function pick(r) {
  const { status, path: p, symbol, detail, suggestion, auto } = r
  return { status, now: p ? `${p}${symbol ? '#' + symbol : ''}` : null, detail: detail ?? null, suggestion: suggestion ?? null, auto }
}

function touchedSince(repo, base) {
  const mb = git(repo, ['merge-base', base, 'HEAD'])
  const from = mb.ok ? mb.out.trim() : base
  const files = new Set()
  const r = git(repo, ['diff', '--name-status', '-M50%', from])
  for (const line of r.out.split('\n').filter(Boolean)) {
    const parts = line.split('\t')
    parts.slice(1).forEach(p => files.add(p))
  }
  git(repo, ['ls-files', '--others', '--exclude-standard']).out.split('\n').filter(Boolean).forEach(f => files.add(f))
  return files
}

const FOLLOW_UP = {
  'known-slop': 'code changed under a known-slop entry: re-run its guard test (fixed: still green? open: still red?), then reanchor --accept',
  decision: 'code changed under this decision: re-read it before relying on it, then reanchor --accept (or retire it)',
  default: 'code changed under this entry: confirm it still applies, then reanchor --accept',
}

function check(repo, { changed = false, base } = {}) {
  const touched = changed ? touchedSince(repo, base ?? 'origin/main') : null
  const rows = []
  for (const e of loadEntries(repo)) {
    if (e._error) { rows.push({ id: e._file, status: 'INVALID', detail: e._error }); continue }
    if (e.status === 'retired') continue
    for (const a of e.anchors ?? []) {
      if (touched && !touched.has(a.path)) continue
      const r = resolveAnchor(repo, a)
      rows.push({ id: e.id, title: e.title, kind: e.kind, ref: `${a.path}${a.symbol ? '#' + a.symbol : ''}`, ...r, followUp: r.status === 'DRIFTED' ? (FOLLOW_UP[e.kind] ?? FOLLOW_UP.default) : null })
    }
  }
  const problems = rows.filter(r => changed ? r.status !== 'FRESH' : ['STALE', 'SPLIT', 'INVALID'].includes(r.status))
  return { rows, problems }
}

function reanchor(repo, id, o) {
  const e = getEntry(repo, id)
  const history = e.history ?? []
  const now = new Date().toISOString()
  let anchors
  if (o.to) {
    anchors = [makeAnchor(repo, o.to, { role: 'subject' }), ...list(o.also).map(r => makeAnchor(repo, r, { role: 'subject' })), ...(e.anchors ?? []).filter(a => a.role === 'guard').map(a => safeAnchor(repo, a))]
  } else {
    anchors = (e.anchors ?? []).map(a => {
      const r = resolveAnchor(repo, a)
      if (r.status === 'FRESH') return a
      if (o.accept && ['DRIFTED', 'MOVED', 'RENAMED'].includes(r.status)) return makeAnchor(repo, { path: r.path, symbol: r.symbol }, { role: a.role })
      if (o.auto && ['MOVED', 'RENAMED'].includes(r.status) && r.auto && !r.drifted) return makeAnchor(repo, { path: r.path, symbol: r.symbol }, { role: a.role })
      throw new Refusal(`${a.path}${a.symbol ? '#' + a.symbol : ''} is ${r.status}${r.auto === false && ['MOVED', 'RENAMED'].includes(r.status) ? ' (not unique enough to move automatically)' : ''}: use --to <path>#<symbol>${r.status === 'DRIFTED' ? ' or --accept' : ''}`)
    })
  }
  history.push({ at: now, anchors: e.anchors })
  const next = { ...e, anchors, history, updated: now }
  writeEntry(repo, next)
  return next
}

function safeAnchor(repo, a) {
  try { return makeAnchor(repo, { path: a.path, symbol: a.symbol }, { role: a.role }) } catch { return a }
}

function retire(repo, id, reason) {
  if (!reason || reason === true) throw new Refusal('retire needs --reason "<why>"')
  const e = getEntry(repo, id)
  const now = new Date().toISOString()
  const next = { ...e, status: e.kind === 'known-slop' ? 'waived' : 'retired', retired: { at: now, reason }, updated: now }
  if (e.kind === 'known-slop') next.waiver = { reason, expires: null }
  writeEntry(repo, next)
  return next
}

function lint(repo) {
  const entries = loadEntries(repo)
  const ids = new Set(entries.map(e => e.id))
  const problems = []
  for (const e of entries) {
    if (e._error) { problems.push(`${e._file}: unreadable JSON (${e._error})`); continue }
    if (`${e.id}.json` !== e._file) problems.push(`${e._file}: file name does not match id ${e.id}`)
    for (const err of validate(e)) problems.push(`${e._file}: ${err}`)
    for (const h of scanFields(Object.fromEntries(Object.entries(e).filter(([k]) => !k.startsWith('_'))))) problems.push(`${e._file}: possible secret in ${h.field} (${h.detector})`)
    for (const s of e.supersedes ?? []) if (!ids.has(s)) problems.push(`${e._file}: supersedes unknown entry ${s}`)
  }
  return problems
}

// Pack defaults (skills/eng-*/checks.json in jstack) overlaid with the project's .jstack/budgets.json.
function budgets(repo) {
  const out = {}
  const skills = path.join(JSTACK_ROOT, 'skills')
  let dirs = []
  // unslop-ignore: conc.empty-catch no packs installed means no pack defaults
  try { dirs = fs.readdirSync(skills).filter(d => d.startsWith('eng-')) } catch {}
  for (const d of dirs) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(skills, d, 'checks.json'), 'utf8'))
      for (const b of c.budgets ?? []) out[b.key] = { value: b.default, unit: b.unit, measure: b.measure, source: b.source ?? `${d} default`, from: 'pack' }
      // unslop-ignore: conc.empty-catch a pack without budgets is fine; packs.test.mjs parses every checks.json
    } catch {}
  }
  try {
    const p = JSON.parse(fs.readFileSync(path.join(repo, '.jstack', 'budgets.json'), 'utf8'))
    for (const [k, v] of Object.entries(p.budgets ?? {})) out[k] = { ...(out[k] ?? {}), ...v, from: 'project' }
    // unslop-ignore: conc.empty-catch the project has no budgets.json yet
  } catch {}
  return out
}

function printQuery(rows) {
  if (!rows.length) { console.log('no memory entries for these paths/domains'); return }
  for (const { entry: e, anchors } of rows) {
    console.log(`${e.id}  [${e.kind}/${e.status}]  ${e.title}`)
    for (const a of anchors) console.log(`    ${a.status.padEnd(8)} ${a.ref}${a.now && a.now !== a.ref ? ` -> ${a.now}` : ''}${a.status !== 'FRESH' ? '  (read as a question, not a fact)' : ''}`)
    if (e.lesson) console.log(`    lesson: ${e.lesson}`)
  }
}

function printCheck({ rows, problems }, changed) {
  for (const r of rows) {
    const mark = problems.includes(r) ? r.status : (r.status === 'FRESH' ? 'FRESH' : r.status)
    console.log(`${mark.padEnd(8)} ${r.id}  ${r.title ? `"${r.title}"` : ''}`)
    if (r.ref) console.log(`         anchor ${r.ref}${r.path && r.path !== r.ref.split('#')[0] ? ` -> ${r.path}${r.symbol ? '#' + r.symbol : ''}` : ''}${r.detail ? `  (${r.detail})` : ''}`)
    if (r.candidates?.length && r.status !== 'RENAMED') console.log(`         best matches: ${r.candidates.map(c => `${c.path}#${c.symbol} (${c.similarity})`).join(', ')}`)
    if (r.followUp) console.log(`         ${r.followUp}`)
    if (r.suggestion) console.log(`         fix: ${r.suggestion.replaceAll('<id>', r.id)}`)
    else if (['MOVED', 'RENAMED'].includes(r.status)) console.log(`         fix: memory.mjs reanchor ${r.id} ${r.auto && !r.drifted ? '--auto' : '--accept'}`)
  }
  console.log(problems.length ? `memory: ${problems.length} anchor(s) need attention${changed ? ' in files this branch touched' : ''}` : 'memory: anchors ok')
}

async function main(argv) {
  const o = parseArgs(argv)
  const [cmd, id] = o._
  const repo = repoRoot(o)
  try {
    switch (cmd) {
      case 'init': { const made = init(repo); console.log(made.length ? `created ${made.join(', ')}` : '.jstack already set up'); return 0 }
      case 'add': {
        if (!KINDS.includes(o.kind)) throw new Refusal(`--kind one of ${KINDS.join(', ')}`)
        const e = add(repo, o)
        console.log(o.json ? JSON.stringify(e, null, 2) : e.id)
        if (e.fingerprint && (e.kind === 'false-positive' || e.status === 'waived') && memoryLocation(repo).external) {
          console.error('note: memory lives outside the repo, so the diff-mode scan and the READY gate do not read this suppression (nobody reviewed it). For the gate, add a waiver to .jstack/unslop.json in its own reviewed PR, or an unslop-ignore with a reason on the line.')
        }
        return 0
      }
      case 'where': {
        const loc = memoryLocation(repo)
        if (o.json) console.log(JSON.stringify(loc, null, 2))
        else if (o.tsv) console.log(`${loc.external ? 'external' : 'repo'}\t${loc.external ? loc.dir.replace(/\\/g, '/') : loc.rel}`)
        else console.log(`${loc.entries}\n${loc.external ? 'outside the repo, shared by every worktree, never committed' : 'in the repo, committed with the branch'} (${loc.from})`)
        return 0
      }
      case 'query': {
        const rows = query(repo, { paths: list(o.paths), domains: list(o.domains), kinds: list(o.kinds), all: !!o.all })
        if (o.json) console.log(JSON.stringify(rows.map(r => ({ ...r, entry: { ...r.entry, _file: undefined } })), null, 2))
        else printQuery(rows)
        return 0
      }
      case 'show': {
        const e = getEntry(repo, id)
        delete e._file
        console.log(JSON.stringify(e, null, 2))
        return 0
      }
      case 'check': {
        const r = check(repo, { changed: !!o.changed, base: o.base })
        if (o.json) console.log(JSON.stringify(r, null, 2))
        else printCheck(r, !!o.changed)
        return r.problems.length ? 1 : 0
      }
      case 'reanchor': {
        if (!id) throw new Refusal('reanchor <id> (--auto | --accept | --to path#symbol)')
        if (!o.auto && !o.accept && !o.to) throw new Refusal('reanchor needs --auto, --accept or --to path#symbol')
        const e = reanchor(repo, id, o)
        console.log(`reanchored ${e.id}: ${e.anchors.map(a => `${a.path}${a.symbol ? '#' + a.symbol : ''}`).join(', ')}`)
        return 0
      }
      case 'retire': { const e = retire(repo, id, o.reason); console.log(`${e.id} is ${e.status}`); return 0 }
      case 'lint': {
        const p = lint(repo)
        p.forEach(x => console.log(x))
        console.log(p.length ? `lint: ${p.length} problem(s)` : 'lint: ok')
        return p.length ? 1 : 0
      }
      case 'export': { console.log(JSON.stringify(loadEntries(repo).map(({ _file, ...e }) => e), null, 2)); return 0 }
      case 'budgets': {
        const b = budgets(repo)
        if (o.json) console.log(JSON.stringify(b, null, 2))
        else for (const [k, v] of Object.entries(b).sort()) console.log(`${k.padEnd(34)} ${String(v.value ?? 'unset (measure first)').padEnd(10)} ${v.unit ?? ''}  [${v.from}] ${v.measure ?? ''}`)
        return 0
      }
      default:
        console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 21).filter(l => l.startsWith('//')).map(l => l.replace(/^\/\/ ?/, '')).join('\n'))
        return cmd ? 2 : 0
    }
  } catch (e) {
    if (e instanceof Refusal) { console.error(e.message); return 2 }
    console.error(String(e?.message ?? e))
    return 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then(code => process.exit(code))

export { main, init, add, query, check, reanchor, retire, lint, budgets, validate, writeEntry, createEntry, loadEntries, newId, parseArgs, splitRef, Refusal, IdTaken }
