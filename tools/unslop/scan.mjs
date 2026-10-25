#!/usr/bin/env node
// Static red-flag scan. A hit is a candidate (a hypothesis), never a finding: /unslop confirms it with evidence.
//   node scan.mjs --base origin/main            lines this branch added (plus untracked files), the default scope
//   node scan.mjs --full src/                   every tracked file under a path (git ls-files, never a disk walk)
//   node scan.mjs --root <dir>                  every file in a small folder (fixtures)
// Options: --domain a,b  --rule id[,id]  --repo <dir>  --json (JSONL)  --out <file>  --fail-on-find (exit 1 on hits)
// Rules come from skills/eng-*/checks.json and .jstack/unslop.json. Engines: regex and script run here; eyes rules
// go to review agents; measure rules need a running target; semgrep and ast-grep rules run through adapters.mjs when
// the tool is installed; anything else is printed as "not checked", never skipped.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { loadRules, loadProjectConfig, loadProjectConfigAt, baseCommit, readAtRef, matchAny, ignoreGlobs } from './rules.mjs'
import { SCRIPTS } from './scripts.mjs'
import { runAdapter, ADAPTED } from './adapters.mjs'
import { enclosingSymbol, normalize, hashText, langOf } from '../memory/symbols.mjs'

const MAX_BYTES = 1 << 20

function git(repo, args) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 256 << 20 })
  return { ok: r.status === 0, out: (r.stdout ?? '').replace(/\r/g, '') }
}

function readText(abs) {
  try {
    const st = fs.statSync(abs)
    if (!st.isFile() || st.size > MAX_BYTES) return null
    const t = fs.readFileSync(abs, 'utf8')
    return t.includes('\0') ? null : t.replace(/\r\n/g, '\n')
  } catch { return null }
}

// Parses `git diff -U0` into Map(path -> Set(added line numbers)).
function parseDiff(text) {
  const out = new Map()
  let cur = null, line = 0
  for (const l of text.split('\n')) {
    if (l.startsWith('+++ ')) {
      const p = l.slice(4)
      cur = p === '/dev/null' ? null : p.replace(/^b\//, '').replace(/^"|"$/g, '')
      if (cur && !out.has(cur)) out.set(cur, new Set())
      continue
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(l)
    if (h) { line = Number(h[1]); continue }
    if (!cur || l.startsWith('---')) continue
    if (l.startsWith('+')) { out.get(cur).add(line); line++ }
  }
  return out
}

function walk(root) {
  const out = []
  const visit = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) visit(abs)
      else if (e.isFile()) out.push(path.relative(root, abs).replace(/\\/g, '/'))
    }
  }
  visit(root)
  return out.sort()
}

// Builds the file set to scan. Each file: { path, text, added: Set|null } (null = every line is in scope).
function collect({ repo, base, full, root, diffStatus }) {
  if (root) {
    const files = walk(root).map(p => ({ path: p, text: readText(path.join(root, p)), added: null })).filter(f => f.text !== null)
    return { files, base: root, all: true, diffStatus: new Map(Object.entries(diffStatus ?? {})), listFiles: globs => files.filter(f => matchAny(f.path, globs)) }
  }
  const listTracked = globs => git(repo, ['ls-files']).out.split('\n').filter(p => p && matchAny(p, globs)).map(p => ({ path: p, text: readText(path.join(repo, p)) })).filter(f => f.text !== null)
  if (full) {
    const rel = path.relative(repo, path.resolve(repo, full)).replace(/\\/g, '/') || '.'
    const files = git(repo, ['ls-files', '--', rel]).out.split('\n').filter(Boolean).map(p => ({ path: p, text: readText(path.join(repo, p)), added: null })).filter(f => f.text !== null)
    return { files, base: repo, all: true, diffStatus: new Map(), listFiles: listTracked }
  }
  const mb = git(repo, ['merge-base', base, 'HEAD'])
  const from = mb.ok ? mb.out.trim() : base
  const added = parseDiff(git(repo, ['diff', '-U0', '--no-color', '--no-ext-diff', '-M50%', from]).out)
  const status = new Map()
  for (const l of git(repo, ['diff', '--name-status', '-M50%', from]).out.split('\n').filter(Boolean)) {
    const [st, a, b] = l.split('\t')
    status.set(b ?? a, st)
    if (b && st.startsWith('R')) status.set(a, st)
  }
  for (const p of git(repo, ['ls-files', '--others', '--exclude-standard']).out.split('\n').filter(Boolean)) {
    added.set(p, null)
    status.set(p, 'A')
  }
  const files = [...added].map(([p, set]) => ({ path: p, text: readText(path.join(repo, p)), added: set })).filter(f => f.text !== null)
  return { files, base: repo, all: false, diffStatus: status, listFiles: listTracked, from }
}

function ruleApplies(rule, file, ignore) {
  if (ignore.length && matchAny(file, ignore)) return false
  if (rule.excludePaths && matchAny(file, rule.excludePaths)) return false
  if (rule.files) return matchAny(file, rule.files)
  if (rule.languages) return rule.languages.includes(path.posix.extname(file).slice(1).toLowerCase())
  return true
}

// The inline unslop-ignore on the hit's line or the line above: { reason, line } or null.
function suppressedInline(lines, line, ruleId) {
  for (const at of [line, line - 1]) {
    const l = lines[at - 1]
    if (!l) continue
    const m = /unslop-ignore(?::|\s)\s*([\w.,-]+)?\s*(.*)$/.exec(l)
    if (m && (!m[1] || m[1].split(',').includes(ruleId) || m[1] === 'all')) return { reason: m[2]?.trim() || 'inline unslop-ignore', line: at }
  }
  return null
}

function fingerprintOf(ruleId, file, text, line, endLine) {
  const lines = text.split('\n')
  const snippet = normalize(lines.slice(line - 1, endLine).join('\n'), langOf(file) ?? 'ts')
  const snippetHash = hashText(snippet)
  const sym = langOf(file) ? enclosingSymbol(text, file, line) : null
  const anchor = sym ? `${file}#${sym.qname}` : `${file}@${hashText(normalize(lines.slice(Math.max(0, line - 2), line + 1).join('\n'), langOf(file) ?? 'ts')).slice(7, 15)}`
  return { symbol: sym?.qname ?? null, snippet_hash: snippetHash, fingerprint: `${ruleId}|${anchor}|${snippetHash.slice(7, 11)}` }
}

function regexHits(rule, file) {
  const flags = (rule.flags ?? '').replace(/[gm]/g, '')
  const lines = file.text.split('\n')
  const hits = []
  if (rule.ifFile && !new RegExp(rule.ifFile, flags).test(file.text)) return hits
  if (rule.unlessFile && new RegExp(rule.unlessFile, flags).test(file.text)) return hits
  const unless = rule.unless ? new RegExp(rule.unless, flags) : null
  const inScope = (a, b) => !file.added || rule.scope === 'file' || rule.scope === 'repo' || [...Array(b - a + 1).keys()].some(i => file.added.has(a + i))
  if (rule.multiline) {
    const re = new RegExp(rule.pattern, flags + 'g')
    let m
    while ((m = re.exec(file.text))) {
      const start = file.text.slice(0, m.index).split('\n').length
      const end = start + m[0].split('\n').length - 1
      if (inScope(start, end) && !(unless && unless.test(lines[start - 1]))) hits.push({ line: start, endLine: end, snippet: lines[start - 1].trim() })
      if (!m[0].length) re.lastIndex++
    }
    return hits
  }
  const re = new RegExp(rule.pattern, flags)
  lines.forEach((l, i) => {
    if (!inScope(i + 1, i + 1) || !re.test(l) || (unless && unless.test(l))) return
    hits.push({ line: i + 1, endLine: i + 1, snippet: l.trim() })
  })
  return hits
}

const ENTRIES_DIR = '.jstack/memory/entries'

// Memory entries as text: from the working tree, or from `ref` (diff mode, so a branch can't waive its own hits).
function memoryEntryTexts(repo, ref) {
  if (!repo) return []
  if (ref) {
    const list = git(repo, ['ls-tree', '-r', '--name-only', '--end-of-options', ref, '--', ENTRIES_DIR])
    if (!list.ok) return []
    return list.out.split('\n').filter(f => f.endsWith('.json')).map(f => readAtRef(repo, ref, f)).filter(t => t != null)
  }
  let files = []
  try { files = fs.readdirSync(path.join(repo, ENTRIES_DIR)).filter(f => f.endsWith('.json')) } catch { return [] }
  return files.map(f => readText(path.join(repo, ENTRIES_DIR, f))).filter(t => t != null)
}

// What a memory entry suppresses, if anything: a false positive, or a waived known slop (which carries an expiry).
function suppressionOf(e) {
  if (!e?.fingerprint) return null
  if (e.kind === 'false-positive') return { fingerprint: e.fingerprint, reason: `known false positive (memory ${e.id})`, waiver: false }
  if (e.kind === 'known-slop' && e.status === 'waived') return { fingerprint: e.fingerprint, reason: `waived known slop (memory ${e.id}): ${e.waiver?.reason ?? ''}`, waiver: true, expires: e.waiver?.expires ?? null }
  return null
}

function loadMemorySuppressions(repo, ref = null) {
  const out = new Map()
  for (const t of memoryEntryTexts(repo, ref)) {
    try {
      const sup = suppressionOf(JSON.parse(t))
      if (sup) out.set(sup.fingerprint, sup)
      // unslop-ignore: conc.empty-catch a malformed entry only loses its suppression; memory.mjs lint reports it
    } catch {}
  }
  return out
}

// A waiver counts while its expiry is in the future. One without an expiry never covers a high-severity hit:
// high findings get waived for a while, not forever.
function waiverActive(w, severity, now = Date.now()) {
  if (!w) return false
  if (w.waiver === false) return true
  if (w.expires) return Date.parse(w.expires) > now
  return severity !== 'high'
}

// Diff mode: a branch that adds or edits its own suppressions gets them on the report as their own hits.
const SELF_RULES = {
  'unslop.config-changed': { title: 'The branch changes the unslop config (rule modes, waivers, ignores, gate); the scan used the base copy', why: 'A branch must not loosen the checks that judge it. The change counts once a reviewer merges it.', fixHint: 'land the config change in its own reviewed PR first' },
  'unslop.new-waiver': { title: 'The branch adds or edits a memory waiver or false positive; the scan used the base copy', why: 'A waiver written by the branch it waives is self-certification.', fixHint: 'get the waiver reviewed on its own, with an expiry for high-severity rules' },
  'unslop.new-suppression': { title: 'The branch adds an inline unslop-ignore', why: 'A suppression written in the same diff as the hit it hides needs a reviewer to see both.', fixHint: 'name the reason in the comment; the reviewer accepts or rejects it' },
}

function selfCandidate(ruleId, { path: p, line, snippet, severity = 'high', mode = 'block-when-confirmed', domain = 'agent-discipline', runId, detail = null }) {
  const meta = SELF_RULES[ruleId]
  const fp = `${ruleId}|${p}@${line}|${hashText(normalize(String(snippet ?? ''), 'ts')).slice(7, 11)}`
  return {
    id: 'c-' + crypto.createHash('sha1').update(fp + (detail ?? '')).digest('hex').slice(0, 6),
    run: runId, source: 'static', rule: ruleId, domain, title: meta.title, path: p, line, endLine: line,
    snippet: String(snippet ?? '').slice(0, 200), detail, symbol: null, snippet_hash: null, fingerprint: fp,
    scenario: meta.why, severity, mode, confirmHint: 'static-proof: the diff itself', fixHint: meta.fixHint,
  }
}

function jstackSelfCandidates(ctx, repo, runId) {
  const out = []
  for (const [p, st] of ctx.diffStatus) {
    if (!p.startsWith('.jstack/') || st === 'D') continue
    if (p === '.jstack/unslop.json') {
      out.push(selfCandidate('unslop.config-changed', { path: p, line: 1, snippet: st === 'A' ? 'new file' : 'modified', runId, detail: st === 'A' ? 'added by this branch' : 'modified by this branch' }))
      continue
    }
    if (!p.startsWith(ENTRIES_DIR + '/') || !p.endsWith('.json')) continue
    let sup = null
    try { sup = suppressionOf(JSON.parse(readText(path.join(repo, p)) ?? '')) } catch { sup = null }
    if (sup) out.push(selfCandidate('unslop.new-waiver', { path: p, line: 1, snippet: sup.reason, runId, detail: `fingerprint ${sup.fingerprint}` }))
  }
  return out
}

// Runs the scan. Returns { candidates, suppressed, notChecked, eyesRules, files, ms }.
function scan(opts = {}) {
  const t0 = Date.now()
  const repo = opts.root ? null : path.resolve(opts.repo ?? process.cwd())
  const diffMode = !opts.root && !opts.full
  const trustRef = diffMode ? baseCommit(repo, opts.base ?? 'origin/main') : null
  const project = opts.root ? null : (diffMode ? loadProjectConfigAt(repo, trustRef) : loadProjectConfig(repo))
  const ignore = opts.root ? [] : ignoreGlobs(project)
  const rules = opts.rules ?? loadRules({ repo, project, domains: opts.domains ?? null, ruleIds: opts.ruleIds ?? null })
  const ctx = collect({ repo, base: opts.base ?? 'origin/main', full: opts.full, root: opts.root, diffStatus: opts.diffStatus })
  const runId = opts.runId ?? new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z-' + crypto.randomBytes(2).toString('hex')
  const waivers = new Map((project?.waivers ?? []).filter(w => w?.fingerprint).map(w => [w.fingerprint, { reason: 'waiver: ' + w.reason, waiver: true, expires: w.expires ?? null }]))
  const memory = loadMemorySuppressions(repo, diffMode ? trustRef : null)
  const candidates = [], suppressed = [], notChecked = [], eyesRules = []
  for (const rule0 of rules) {
    let rule = rule0
    let adapted = null
    if (ADAPTED.has(rule.engine)) {
      adapted = runAdapter(rule, ctx, f => ruleApplies(rule, f, ignore), opts.adapterOptions)
      if (adapted.notChecked) {
        if (rule.fallback?.engine === 'regex' || rule.fallback?.engine === 'eyes') { rule = { ...rule, ...rule.fallback }; adapted = null }
        else { notChecked.push({ rule: rule.id, reason: adapted.notChecked }); continue }
      }
    }
    if (!adapted && !['regex', 'script', 'eyes', 'measure'].includes(rule.engine)) {
      if (rule.fallback?.engine === 'regex' || rule.fallback?.engine === 'eyes') rule = { ...rule, ...rule.fallback }
      else { notChecked.push({ rule: rule.id, reason: `not checked: ${rule.engine} engine has no adapter here; run it in CI` }); continue }
    }
    if (!adapted && rule.engine === 'eyes') { eyesRules.push(rule.id); continue }
    if (rule.engine === 'measure') { notChecked.push({ rule: rule.id, reason: 'measure rule: needs a running target, only in /unslop' }); continue }
    let raw = []
    if (adapted) raw = adapted.hits
    else if (rule.engine === 'regex') {
      try { new RegExp(rule.pattern, (rule.flags ?? '').replace(/[gm]/g, '')) } catch (e) { notChecked.push({ rule: rule.id, reason: `not checked: bad pattern (${e.message})` }); continue }
      for (const f of ctx.files) if (ruleApplies(rule, f.path, ignore)) for (const h of regexHits(rule, f)) raw.push({ ...h, path: f.path, text: f.text })
    } else {
      const fn = SCRIPTS[rule.script]
      if (!fn) { notChecked.push({ rule: rule.id, reason: `not checked: unknown script ${rule.script}` }); continue }
      const sctx = { ...ctx, files: ctx.files.filter(f => !ignore.length || !matchAny(f.path, ignore)) }
      for (const h of fn(sctx, rule)) raw.push({ ...h, endLine: h.line, text: ctx.files.find(f => f.path === h.path)?.text ?? '' })
    }
    for (const h of raw) {
      const lines = h.text.split('\n')
      const fp = fingerprintOf(rule.id, h.path, h.text || h.snippet || '', h.line, h.endLine)
      const c = {
        id: 'c-' + crypto.createHash('sha1').update(fp.fingerprint + h.line).digest('hex').slice(0, 6),
        run: runId,
        source: 'static',
        rule: rule.id,
        domain: rule.domain,
        title: rule.title,
        path: h.path,
        line: h.line,
        endLine: h.endLine,
        snippet: (h.snippet ?? '').slice(0, 200),
        detail: h.detail ?? null,
        ...fp,
        scenario: rule.why ?? rule.title,
        severity: rule.severity ?? 'medium',
        mode: rule.effective?.mode ?? rule.mode ?? 'warn',
        confirmHint: rule.confirm ?? null,
        fixHint: rule.fixHint ?? null,
      }
      const inline = suppressedInline(lines, h.line, rule.id)
      const stored = [waivers.get(c.fingerprint), memory.get(c.fingerprint)].find(w => waiverActive(w, c.severity))
      const why = inline?.reason ?? stored?.reason
      if (why) suppressed.push({ candidate: c, reason: why })
      else candidates.push(c)
      const file = ctx.files.find(f => f.path === h.path)
      if (inline && !ctx.all && file && (!file.added || file.added.has(inline.line))) {
        candidates.push(selfCandidate('unslop.new-suppression', { path: h.path, line: inline.line, snippet: lines[inline.line - 1]?.trim(), severity: c.severity, mode: c.mode, domain: c.domain, runId, detail: 'hides ' + rule.id + ' at line ' + h.line }))
      }
    }
  }
  if (diffMode && repo) candidates.push(...jstackSelfCandidates(ctx, repo, runId))
  return { run: runId, candidates, suppressed, notChecked, eyesRules, files: ctx.files.length, ms: Date.now() - t0 }
}

function parseArgs(argv) {
  const o = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const k = a.slice(2), v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) o[k] = true
    else { o[k] = v; i++ }
  }
  return o
}

function main(argv) {
  const o = parseArgs(argv)
  const res = scan({
    repo: o.repo, base: o.base, full: o.full, root: o.root,
    domains: o.domain ? String(o.domain).split(',') : null,
    ruleIds: o.rule ? String(o.rule).split(',') : null,
    diffStatus: o['diff-status'] ? JSON.parse(fs.readFileSync(o['diff-status'], 'utf8')) : undefined,
  })
  const out = o.json
    ? res.candidates.map(c => JSON.stringify(c)).join('\n') + (res.candidates.length ? '\n' : '')
    : [
        ...res.candidates.map(c => `${c.severity.padEnd(6)} ${c.rule}  ${c.path}:${c.line}  ${c.title}${c.detail ? ` (${c.detail})` : ''}`),
        ...res.suppressed.map(s => `skip   ${s.candidate.rule}  ${s.candidate.path}:${s.candidate.line}  ${s.reason}`),
        ...res.notChecked.map(n => `----   ${n.rule}  ${n.reason}`),
        `scan: ${res.candidates.length} candidate(s), ${res.suppressed.length} suppressed, ${res.files} file(s), ${res.eyesRules.length} eyes-only rule(s) for review agents, ${res.ms} ms`,
      ].join('\n') + '\n'
  if (o.out) fs.writeFileSync(o.out, out)
  else process.stdout.write(out)
  return o['fail-on-find'] && res.candidates.length ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)))

export { scan, parseDiff, collect, regexHits, fingerprintOf, ruleApplies, waiverActive, loadMemorySuppressions, SELF_RULES, main }
