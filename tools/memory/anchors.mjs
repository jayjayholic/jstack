// Anchor resolution for project memory: where does an entry's code live now, and did it change?
// Statuses: FRESH (same body), DRIFTED (same symbol, body changed), MOVED (file or symbol moved, found by git rename
// detection or by name), RENAMED (found by body similarity), SPLIT (body spread over several symbols), STALE (gone).
// Only a unique MOVED/RENAMED is safe to re-anchor automatically; SPLIT and STALE need an agent or a human.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { langOf, symbolsOf, findSymbol, sliceLines, bodyHash, fingerprints, jaccard, coverage } from './symbols.mjs'

const RENAME_MIN = 0.6
const RENAME_MARGIN = 0.15
const SPLIT_PART = 0.25
const SPLIT_TOTAL = 0.7

function git(repo, args) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 << 20 })
  return { ok: r.status === 0, out: (r.stdout ?? '').replace(/\r/g, ''), err: r.stderr ?? '' }
}

function headSha(repo) {
  return git(repo, ['rev-parse', '--short=12', 'HEAD']).out.trim() || null
}

function readFile(repo, rel) {
  try { return fs.readFileSync(path.join(repo, rel), 'utf8') } catch { return null }
}

function showAt(repo, commit, rel) {
  const r = git(repo, ['show', `${commit}:${rel}`])
  return r.ok ? r.out : null
}

function splitRef(ref) {
  const i = ref.lastIndexOf('#')
  return i < 0 ? { path: ref, symbol: null } : { path: ref.slice(0, i), symbol: ref.slice(i + 1) || null }
}

// Builds an anchor for path[#symbol] at the current working tree.
function makeAnchor(repo, ref, { role = 'subject', commit } = {}) {
  const { path: rel, symbol } = typeof ref === 'string' ? splitRef(ref) : ref
  const posix = rel.replace(/\\/g, '/')
  const text = readFile(repo, posix)
  if (text === null) throw new Error(`anchor path not found: ${posix}`)
  const lang = langOf(posix)
  const base = { path: posix, symbol: null, symbolKind: null, lang, commit: commit ?? headSha(repo), role }
  if (!symbol) return { ...base, hash: bodyHash(text, lang ?? 'ts'), lines: [1, text.split('\n').length] }
  const s = findSymbol(text, posix, symbol)
  if (!s) throw new Error(`symbol ${symbol} not found in ${posix}`)
  return { ...base, symbol: s.qname, symbolKind: s.kind, hash: bodyHash(sliceLines(text, s.start, s.end), lang), lines: [s.start, s.end] }
}

// New path of a file renamed since `commit` (committed or in the working tree), or null.
function renamedTo(repo, commit, rel) {
  for (const args of [['diff', '-M50%', '--name-status', commit], ['diff', '-M50%', '--name-status', commit, 'HEAD']]) {
    const r = git(repo, args)
    if (!r.ok) continue
    for (const line of r.out.split('\n')) {
      const parts = line.split('\t')
      if (/^R\d*$/.test(parts[0]) && parts[1] === rel && parts[2]) return parts[2]
    }
  }
  return null
}

function oldBody(repo, anchor) {
  const text = showAt(repo, anchor.commit, anchor.path)
  if (text === null) return null
  if (!anchor.symbol) return text
  const s = findSymbol(text, anchor.path, anchor.symbol)
  return s ? sliceLines(text, s.start, s.end) : null
}

function symbolEntries(repo, files, lang) {
  const out = []
  for (const f of files) {
    if (langOf(f) !== lang) continue
    const text = readFile(repo, f)
    if (text === null) continue
    for (const s of symbolsOf(text, f)) {
      const body = sliceLines(text, s.start, s.end)
      out.push({ path: f, symbol: s.qname, name: s.name, kind: s.kind, lines: [s.start, s.end], hash: bodyHash(body, s.lang), fp: fingerprints(body, s.lang) })
    }
  }
  return out
}

function changedSince(repo, commit) {
  const files = new Set()
  for (const args of [['diff', '--name-only', '-M50%', commit], ['diff', '--name-only', '-M50%', commit, 'HEAD']]) {
    const r = git(repo, args)
    if (r.ok) r.out.split('\n').filter(Boolean).forEach(f => files.add(f))
  }
  return [...files]
}

function removalCommit(repo, anchor) {
  const name = anchor.symbol ? anchor.symbol.split('.').pop() : null
  const args = name ? ['log', '-S', name, '--format=%h %s', '-1', `${anchor.commit}..HEAD`, '--', anchor.path] : ['log', '--diff-filter=D', '--format=%h %s', '-1', `${anchor.commit}..HEAD`, '--', anchor.path]
  const r = git(repo, args)
  return r.out.trim() || null
}

function result(status, extra) {
  return { status, auto: false, ...extra }
}

// Resolves one anchor against the current working tree.
function resolveAnchor(repo, anchor) {
  const lang = anchor.lang ?? langOf(anchor.path)
  let cur = anchor.path
  let moved = false
  if (readFile(repo, cur) === null) {
    const to = anchor.commit ? renamedTo(repo, anchor.commit, anchor.path) : null
    if (to) { cur = to; moved = true }
  }
  const text = readFile(repo, cur)

  if (!anchor.symbol) {
    if (text === null) return result('STALE', { path: anchor.path, detail: 'file removed', removedIn: anchor.commit ? removalCommit(repo, anchor) : null, suggestion: `memory.mjs retire <id> --reason "<why>"` })
    const hash = bodyHash(text, lang ?? 'ts')
    const lines = [1, text.split('\n').length]
    if (moved) return result('MOVED', { path: cur, symbol: null, hash, lines, drifted: hash !== anchor.hash, auto: true, detail: `renamed ${anchor.path} -> ${cur}` })
    return result(hash === anchor.hash ? 'FRESH' : 'DRIFTED', { path: cur, symbol: null, hash, lines })
  }

  if (text !== null) {
    const s = findSymbol(text, cur, anchor.symbol)
    if (s) {
      const hash = bodyHash(sliceLines(text, s.start, s.end), s.lang)
      const lines = [s.start, s.end]
      if (moved) return result('MOVED', { path: cur, symbol: s.qname, hash, lines, drifted: hash !== anchor.hash, auto: true, detail: `renamed ${anchor.path} -> ${cur}` })
      return result(hash === anchor.hash ? 'FRESH' : 'DRIFTED', { path: cur, symbol: s.qname, hash, lines })
    }
  }

  const body = anchor.commit ? oldBody(repo, anchor) : null
  const oldFp = body ? fingerprints(body, lang) : new Set()
  const bare = anchor.symbol.split('.').pop()

  // Moved symbol: the same name defined in exactly one other place.
  const grep = git(repo, ['grep', '-l', '-w', '-e', bare])
  const named = grep.ok ? symbolEntries(repo, grep.out.split('\n').filter(Boolean), lang).filter(e => e.name === bare) : []
  if (named.length === 1) {
    const e = named[0]
    const sim = body ? jaccard(oldFp, e.fp) : 1
    if (e.hash === anchor.hash || sim >= RENAME_MIN) {
      return result('MOVED', { path: e.path, symbol: e.symbol, hash: e.hash, lines: e.lines, similarity: round(sim), drifted: e.hash !== anchor.hash, auto: e.hash === anchor.hash || sim >= 0.8, detail: `symbol now in ${e.path}` })
    }
  }

  if (!body) return result('STALE', { path: anchor.path, detail: 'no old body to compare (anchor commit missing)', suggestion: `memory.mjs reanchor <id> --to <path>#<symbol>` })

  // Renamed or split: compare the old body's fingerprints with symbols in files changed since the anchor commit.
  const pool = symbolEntries(repo, changedSince(repo, anchor.commit), lang)
  const scored = pool.map(e => ({ ...e, sim: jaccard(oldFp, e.fp), cov: coverage(oldFp, e.fp) })).sort((a, b) => b.sim - a.sim)
  const [best, second] = scored
  const candidates = scored.slice(0, 3).map(e => ({ path: e.path, symbol: e.symbol, similarity: round(e.sim) }))
  if (best && best.sim >= RENAME_MIN) {
    if (!second || best.sim - second.sim >= RENAME_MARGIN) {
      return result('RENAMED', { path: best.path, symbol: best.symbol, hash: best.hash, lines: best.lines, similarity: round(best.sim), auto: true, detail: `best body match ${round(best.sim)}`, candidates })
    }
    return result('STALE', { path: anchor.path, detail: 'ambiguous: two or more symbols match the old body equally well', candidates, suggestion: `memory.mjs reanchor <id> --to <path>#<symbol>` })
  }
  const parts = scored.filter(e => e.cov >= SPLIT_PART).sort((a, b) => b.cov - a.cov)
  if (parts.length >= 2) {
    const union = new Set()
    for (const p of parts) for (const x of oldFp) if (p.fp.has(x)) union.add(x)
    const total = oldFp.size ? union.size / oldFp.size : 0
    if (total >= SPLIT_TOTAL) {
      const ps = parts.map(p => ({ path: p.path, symbol: p.symbol, coverage: round(p.cov) }))
      return result('SPLIT', { path: anchor.path, detail: `old body spread over ${ps.length} symbols (${round(total)} covered)`, parts: ps, suggestion: `memory.mjs reanchor <id> --to ${ps[0].path}#${ps[0].symbol}${ps.slice(1).map(p => ` --also ${p.path}#${p.symbol}`).join('')}` })
    }
  }
  const removedIn = removalCommit(repo, anchor)
  const top = candidates[0]
  return result('STALE', {
    path: anchor.path,
    detail: removedIn ? `removed in ${removedIn}` : 'not found',
    removedIn,
    candidates,
    suggestion: top ? `memory.mjs reanchor <id> --to ${top.path}#${top.symbol}   or: memory.mjs retire <id> --reason "<why>"` : `memory.mjs retire <id> --reason "<why>"`,
  })
}

function round(x) { return Math.round(x * 100) / 100 }

export { makeAnchor, resolveAnchor, renamedTo, splitRef, headSha, git, RENAME_MIN, RENAME_MARGIN }
