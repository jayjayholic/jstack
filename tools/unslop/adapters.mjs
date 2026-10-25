// Adapters for rules whose engine is an external structural matcher: semgrep and ast-grep. When the tool is not
// installed the rule is "not checked: <tool> is not installed", never a pass. Hits are filtered to the lines the
// branch added (diff mode) exactly like regex rules.
//
// Rule shapes in checks.json or .jstack/unslop.json extraRules:
//   { "engine": "semgrep",  "semgrep": { "pattern": "...", "languages": ["typescript"] }, ... }
//   { "engine": "semgrep",  "semgrep": { "patterns": [ {"pattern": "..."}, {"pattern-not": "..."} ], "languages": [...] } }
//   { "engine": "ast-grep", "astGrep": { "pattern": "...", "language": "ts" }, ... }
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const BATCH = 200
const probes = new Map()

// No shell, ever: patterns come from rule config and paths from the repo, and a shell would read both as commands.
// On Windows that means an installed .exe (pip's semgrep.exe, cargo's ast-grep.exe); an npm .cmd shim is not run.
function defaultExec(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 256 << 20, timeout: 5 * 60_000 })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error ?? null }
}

// The first binary name that answers --version, or null. Cached per process.
function findTool(names, exec = defaultExec) {
  const key = names.join('|')
  if (exec === defaultExec && probes.has(key)) return probes.get(key)
  let found = null
  for (const n of names) {
    const r = exec(n, ['--version'], process.cwd())
    if (r.status === 0 && !r.error) { found = n; break }
  }
  if (exec === defaultExec) probes.set(key, found)
  return found
}

function semgrepConfig(rule) {
  const s = rule.semgrep ?? {}
  const body = { id: rule.id.replace(/[^\w.-]/g, '_'), message: rule.title ?? rule.id, severity: 'WARNING', languages: s.languages ?? ['generic'] }
  if (s.patterns) body.patterns = s.patterns
  else if (s['pattern-either']) body['pattern-either'] = s['pattern-either']
  else if (s.pattern) body.pattern = s.pattern
  else if (s['pattern-regex']) body['pattern-regex'] = s['pattern-regex']
  else return null
  return { rules: [body] }
}

// semgrep --json: { results: [{ path, start: { line }, end: { line }, extra: { lines } }] }
function parseSemgrep(stdout) {
  let j
  try { j = JSON.parse(stdout) } catch { return null }
  if (!Array.isArray(j?.results)) return null
  return j.results.map(r => ({ path: String(r.path).replace(/\\/g, '/').replace(/^\.\//, ''), line: r.start?.line, endLine: r.end?.line ?? r.start?.line, snippet: String(r.extra?.lines ?? '').split('\n')[0].trim() })).filter(h => Number.isInteger(h.line))
}

// ast-grep --json=compact: [{ file, range: { start: { line } , end: { line } }, lines }] with 0-based lines.
function parseAstGrep(stdout) {
  let j
  try { j = JSON.parse(stdout || '[]') } catch { return null }
  if (!Array.isArray(j)) return null
  return j.map(m => ({ path: String(m.file).replace(/\\/g, '/').replace(/^\.\//, ''), line: (m.range?.start?.line ?? -1) + 1, endLine: (m.range?.end?.line ?? m.range?.start?.line ?? -1) + 1, snippet: String(m.lines ?? m.text ?? '').split('\n')[0].trim() })).filter(h => h.line > 0)
}

const ENGINES = {
  semgrep: {
    names: ['semgrep'],
    run(rule, files, cwd, tool, exec) {
      const cfg = semgrepConfig(rule)
      if (!cfg) return { error: 'rule has no semgrep pattern' }
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jstack-semgrep-'))
      try {
        const f = path.join(dir, 'rule.json')
        fs.writeFileSync(f, JSON.stringify(cfg))
        const hits = []
        for (let i = 0; i < files.length; i += BATCH) {
          const r = exec(tool, ['--config', f, '--json', '--quiet', '--disable-version-check', '--metrics=off', '--', ...files.slice(i, i + BATCH)], cwd)
          const parsed = parseSemgrep(r.stdout)
          if (!parsed) return { error: `semgrep output unreadable (exit ${r.status})` }
          hits.push(...parsed)
        }
        return { hits }
      } finally { fs.rmSync(dir, { recursive: true, force: true }) }
    },
  },
  'ast-grep': {
    names: ['ast-grep', 'sg'],
    run(rule, files, cwd, tool, exec) {
      const a = rule.astGrep ?? {}
      if (!a.pattern || !a.language) return { error: 'rule needs astGrep.pattern and astGrep.language' }
      const hits = []
      for (let i = 0; i < files.length; i += BATCH) {
        const r = exec(tool, ['run', '--pattern', a.pattern, '--lang', a.language, '--json=compact', '--', ...files.slice(i, i + BATCH)], cwd)
        const parsed = parseAstGrep(r.stdout)
        if (!parsed) return { error: `ast-grep output unreadable (exit ${r.status})` }
        hits.push(...parsed)
      }
      return { hits }
    },
  },
}

const ADAPTED = new Set(Object.keys(ENGINES))

// Runs one adapted rule over the files in scope. Returns { hits } or { notChecked: reason }.
// ctx.files: [{ path, text, added: Set|null }]; ctx.base: the folder the paths are relative to.
function runAdapter(rule, ctx, applies, { exec = defaultExec } = {}) {
  const eng = ENGINES[rule.engine]
  if (!eng) return { notChecked: `not checked: no adapter for ${rule.engine}` }
  const tool = findTool(eng.names, exec)
  if (!tool) return { notChecked: `not checked: ${rule.engine} is not installed (install it, or run this rule in CI)` }
  const files = ctx.files.filter(f => applies(f.path))
  if (!files.length) return { hits: [] }
  const res = eng.run(rule, files.map(f => f.path), ctx.base, tool, exec)
  if (res.error) return { notChecked: `not checked: ${res.error}` }
  const byPath = new Map(files.map(f => [f.path, f]))
  const hits = []
  for (const h of res.hits) {
    const f = byPath.get(h.path)
    if (!f) continue
    const end = Math.max(h.line, h.endLine ?? h.line)
    if (f.added && rule.scope !== 'file' && rule.scope !== 'repo' && ![...Array(end - h.line + 1).keys()].some(i => f.added.has(h.line + i))) continue
    hits.push({ ...h, endLine: end, text: f.text })
  }
  return { hits }
}

export { runAdapter, parseSemgrep, parseAstGrep, semgrepConfig, findTool, ADAPTED }
