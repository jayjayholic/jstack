// Loads the red-flag rules: every skills/eng-*/checks.json pack in jstack, plus the project's tuning in
// .jstack/unslop.json (rule modes and "off", extra rules, house banned words, ignored paths, waivers).
// Field feedback (.jstack/local/feedback.jsonl) moves a rule between warn, block-when-confirmed and eyes-hint.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { wilson } from './stats.mjs'

const JSTACK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SKILLS_DIR = path.join(JSTACK_ROOT, 'skills')
const DEFAULT_IGNORE = ['node_modules/**', '**/node_modules/**', 'dist/**', 'build/**', '.next/**', '**/.next/**', 'vendor/**', '**/vendor/**', 'coverage/**', '**/*.min.js', '**/*.map', '.git/**', '.jstack/**', '**/unslop/fixtures/**']
const CATALOG_GLOBS = ['**/messages/**/*.json', '**/locales/**/*.json', '**/i18n/**/*.json', '**/lang/**/*.json']
const PROMOTE = { n: 10, lower: 0.8 }
const DEMOTE = { n: 10, lower: 0.5 }

function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2 } else { re += '.*'; i++ }
      } else re += '[^/]*'
    } else if (ch === '?') re += '[^/]'
    else if (ch === '{') {
      const end = glob.indexOf('}', i)
      re += '(?:' + glob.slice(i + 1, end).split(',').map(s => s.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|') + ')'
      i = end
    } else re += ch.replace(/[.+^$()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

const globCache = new Map()
function matchGlob(file, glob) {
  if (!globCache.has(glob)) globCache.set(glob, globToRegExp(glob))
  return globCache.get(glob).test(file)
}
const matchAny = (file, globs = []) => globs.some(g => matchGlob(file, g))

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function loadPacks(skillsDir = SKILLS_DIR) {
  let dirs = []
  try { dirs = fs.readdirSync(skillsDir).filter(d => d.startsWith('eng-')).sort() } catch { return [] }
  return dirs.map(d => ({ dir: path.join(skillsDir, d), skill: d, ...readJson(path.join(skillsDir, d, 'checks.json'), {}) })).filter(p => p.domain)
}

function loadProjectConfig(repo) {
  if (!repo) return null
  return readJson(path.join(repo, '.jstack', 'unslop.json'), null)
}

function gitOut(repo, args) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 << 20 })
  return r.status === 0 ? (r.stdout ?? '').replace(/\r/g, '') : null
}

// The commit a branch's diff is measured from: merge-base(base, HEAD), else base itself if it names a commit.
function baseCommit(repo, base) {
  if (!repo || !base) return null
  const mb = gitOut(repo, ['merge-base', '--end-of-options', base, 'HEAD'])?.trim()
  if (mb) return mb
  return gitOut(repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${base}^{commit}`])?.trim() || null
}

// A file as it is at `ref`, or null when it is not there.
function readAtRef(repo, ref, rel) {
  if (!repo || !ref) return null
  return gitOut(repo, ['show', '--end-of-options', `${ref}:${rel}`])
}

// The project config as the base ref has it. A branch can't loosen its own scan or gate: suppressions, waivers,
// rule modes and the gate mode it adds only count once they are on the base branch.
function loadProjectConfigAt(repo, ref) {
  const t = readAtRef(repo, ref, '.jstack/unslop.json')
  if (t == null) return null
  try { return JSON.parse(t) } catch { return null }
}

// Per rule: { n, accepted, rejected, precision, lower } from .jstack/local/feedback.jsonl.
function fieldPrecision(repo, { sinceDays = null } = {}) {
  const out = {}
  if (!repo) return out
  let lines = []
  try { lines = fs.readFileSync(path.join(repo, '.jstack', 'local', 'feedback.jsonl'), 'utf8').split('\n').filter(Boolean) } catch { return out }
  const since = sinceDays ? Date.now() - sinceDays * 86400000 : 0
  for (const l of lines) {
    let r
    try { r = JSON.parse(l) } catch { continue }
    if (!r.rule || (since && Date.parse(r.at) < since)) continue
    const s = out[r.rule] ??= { n: 0, accepted: 0, rejected: 0, duplicate: 0 }
    if (r.verdict === 'accepted') { s.accepted++; s.n++ }
    else if (String(r.verdict).startsWith('rejected')) { s.rejected++; s.n++ }
    else if (r.verdict === 'duplicate') s.duplicate++
  }
  for (const s of Object.values(out)) {
    const w = wilson(s.accepted, s.n)
    s.precision = s.n ? s.accepted / s.n : null
    s.lower = w.lower
    s.upper = w.upper
  }
  return out
}

// The mode a rule runs in for this project: explicit project setting first, then field precision, then "warn".
// A pack's "block-when-confirmed" only means the rule may block once it earned precision here.
function effectiveMode(rule, project, field) {
  const explicit = project?.rules?.[rule.id]?.mode
  if (explicit) return { mode: explicit, why: 'project setting' }
  const f = field?.[rule.id]
  if (f && f.n >= DEMOTE.n && f.lower < DEMOTE.lower) return { mode: 'eyes-hint', why: `field precision lower bound ${f.lower.toFixed(2)} < ${DEMOTE.lower} over ${f.n}: demoted` }
  if (rule.mode === 'eyes-hint') return { mode: 'eyes-hint', why: 'pack' }
  if (rule.mode === 'block-when-confirmed' && f && f.n >= PROMOTE.n && f.lower >= PROMOTE.lower) return { mode: 'block-when-confirmed', why: `earned: lower bound ${f.lower.toFixed(2)} over ${f.n}` }
  return { mode: 'warn', why: rule.mode === 'block-when-confirmed' ? 'not yet earned (needs >= 10 field verdicts with lower bound >= 0.8)' : 'pack' }
}

function houseRules(project) {
  const h = project?.houseRules ?? {}
  const files = h.files ?? CATALOG_GLOBS
  const rules = []
  const words = (h.bannedWords ?? []).filter(Boolean)
  if (words.length) rules.push({ id: 'copy.house-banned', domain: 'copy', title: 'House-banned word in user-facing text', engine: 'regex', pattern: `\\b(?:${words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, flags: 'i', files, scope: 'added', severity: 'medium', mode: 'warn', failureClass: 'house-rule', why: 'The project banned this word; a rule that lives only in memory gets broken.', confirm: 'static-proof: the word is in a user-facing string', house: true })
  const jargon = (h.jargon ?? []).filter(Boolean)
  if (jargon.length) rules.push({ id: 'copy.house-jargon', domain: 'copy', title: 'Internal jargon in user-facing text', engine: 'regex', pattern: `\\b(?:${jargon.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, flags: 'i', files, scope: 'added', severity: 'low', mode: 'warn', failureClass: 'jargon', why: 'Users read the system\'s words instead of theirs.', confirm: 'static-proof plus a cold read of the string', house: true })
  return rules
}

// All rules for the chosen domains, with project tuning applied. Each rule carries .domain and .effectiveMode.
// `project` overrides the config read from the working tree (diff mode passes the merge-base's copy).
function loadRules({ repo = null, domains = null, ruleIds = null, skillsDir = SKILLS_DIR, includeEyes = true, project: given } = {}) {
  const project = given !== undefined ? given : loadProjectConfig(repo)
  const field = fieldPrecision(repo)
  const packs = loadPacks(skillsDir)
  const rules = []
  for (const p of packs) {
    const tactics = new Map((p.tactics ?? []).map(x => [x.id, x]))
    for (const r of p.rules ?? []) rules.push({ ...r, domain: p.domain, ...(r.suggest && tactics.has(r.suggest) ? { tactic: tactics.get(r.suggest) } : {}) })
  }
  for (const r of project?.extraRules ?? []) rules.push({ ...r, domain: r.domain ?? r.id.split('.')[0], project: true })
  rules.push(...houseRules(project))
  return rules
    .filter(r => !domains || domains.includes(r.domain))
    .filter(r => !ruleIds || ruleIds.includes(r.id))
    .filter(r => includeEyes || r.engine !== 'eyes')
    .map(r => ({ ...r, effective: effectiveMode(r, project, field) }))
    .filter(r => r.effective.mode !== 'off')
}

// A pack tactic by id ("cost.t.batches"), so a finding that names one can print what to do and where it comes from.
function tacticById(id, skillsDir = SKILLS_DIR) {
  if (!id || typeof id !== 'string') return null
  for (const p of loadPacks(skillsDir)) {
    const t = (p.tactics ?? []).find(x => x.id === id)
    if (t) return t
  }
  return null
}

function ignoreGlobs(project) {
  return [...DEFAULT_IGNORE, ...(project?.paths?.ignore ?? [])]
}

export { loadPacks, loadRules, tacticById, loadProjectConfig, loadProjectConfigAt, baseCommit, readAtRef, fieldPrecision, effectiveMode, globToRegExp, matchGlob, matchAny, ignoreGlobs, JSTACK_ROOT, SKILLS_DIR, DEFAULT_IGNORE, CATALOG_GLOBS, PROMOTE, DEMOTE }
