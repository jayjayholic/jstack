// Symbol locator for memory anchors and finding fingerprints: names, kinds and line ranges per language, plus the
// normalized-body hash and winnowing fingerprints used to follow a symbol through refactors.
// Built-in and dependency-free (definition regexes + string/comment-aware brace matching, indentation for Python).
// Set JSTACK_SYMBOLS=ctags to use universal-ctags instead when it is installed (UNVERIFIED on Windows).
import crypto from 'node:crypto'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const LANG_BY_EXT = {
  ts: 'ts', tsx: 'ts', js: 'ts', jsx: 'ts', mjs: 'ts', cjs: 'ts', mts: 'ts', cts: 'ts',
  py: 'py', go: 'go', rs: 'rs',
  java: 'java', kt: 'java', kts: 'java', cs: 'java', scala: 'java', swift: 'java',
  c: 'c', h: 'c', cc: 'c', cpp: 'c', hpp: 'c',
}
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'new', 'await', 'typeof', 'else', 'do', 'try', 'super', 'this', 'with', 'yield', 'delete', 'void', 'throw', 'case', 'in', 'of', 'import', 'export', 'sizeof', 'elif', 'match'])

function langOf(file) {
  return LANG_BY_EXT[path.extname(file).slice(1).toLowerCase()] ?? null
}

function lineStarts(text) {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1)
  return starts
}

function lineAt(starts, index) {
  let lo = 0, hi = starts.length - 1
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= index) lo = mid; else hi = mid - 1 }
  return lo + 1
}

// Skips a string or comment starting at i. Returns the index after it, or i when nothing starts there.
function skipLiteral(text, i, lang) {
  const ch = text[i], nx = text[i + 1]
  if (lang !== 'py' && ch === '/' && nx === '/') { const e = text.indexOf('\n', i); return e < 0 ? text.length : e }
  if (lang !== 'py' && ch === '/' && nx === '*') { const e = text.indexOf('*/', i + 2); return e < 0 ? text.length : e + 2 }
  if (lang === 'py' && ch === '#') { const e = text.indexOf('\n', i); return e < 0 ? text.length : e }
  if (lang === 'py' && (text.startsWith('"""', i) || text.startsWith("'''", i))) {
    const q = text.slice(i, i + 3); const e = text.indexOf(q, i + 3); return e < 0 ? text.length : e + 3
  }
  if (ch === "'" && lang === 'rs') {
    const m = /^'(?:\\.|[^\\'])'/.exec(text.slice(i, i + 12))
    return m ? i + m[0].length : i
  }
  if (ch === '"' || ch === "'" || (ch === '`' && (lang === 'ts' || lang === 'go'))) {
    let j = i + 1
    while (j < text.length) {
      if (text[j] === '\\' && ch !== '`') { j += 2; continue }
      if (text[j] === '\\' && ch === '`' && lang === 'ts') { j += 2; continue }
      if (text[j] === ch) return j + 1
      if (text[j] === '\n' && ch !== '`') return j
      j++
    }
    return text.length
  }
  return i
}

// Index of the brace that closes the one opened at `open`.
function matchBrace(text, open, lang) {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const s = skipLiteral(text, i, lang)
    if (s !== i) { i = s - 1; continue }
    if (text[i] === '{') depth++
    else if (text[i] === '}') { depth--; if (depth === 0) return i }
  }
  return text.length - 1
}

function matchParen(text, open, lang) {
  if (open < 0) return -1
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const s = skipLiteral(text, i, lang)
    if (s !== i) { i = s - 1; continue }
    if (text[i] === '(') depth++
    else if (text[i] === ')') { depth--; if (depth === 0) return i }
  }
  return -1
}

// From `from`, finds where the definition's body starts: the first `{` outside parens, or `=>` for arrows.
function bodyStart(text, from, lang, { arrow = false } = {}) {
  let paren = 0
  for (let i = from; i < text.length; i++) {
    const s = skipLiteral(text, i, lang)
    if (s !== i) { i = s - 1; continue }
    const ch = text[i]
    if (ch === '(' || ch === '[') paren++
    else if (ch === ')' || ch === ']') paren--
    else if (paren === 0 && arrow && ch === '=' && text[i + 1] === '>') {
      let j = i + 2
      while (/\s/.test(text[j] ?? '')) j++
      return text[j] === '{' ? { open: j } : { expr: j }
    } else if (paren === 0 && ch === '{') return { open: i }
    else if (paren === 0 && ch === ';') return null
  }
  return null
}

// End of an expression-bodied arrow: the first ; or newline at depth 0.
function exprEnd(text, from, lang) {
  let depth = 0
  for (let i = from; i < text.length; i++) {
    const s = skipLiteral(text, i, lang)
    if (s !== i) { i = s - 1; continue }
    const ch = text[i]
    if ('([{'.includes(ch)) depth++
    else if (')]}'.includes(ch)) { if (depth === 0) return i - 1; depth-- }
    else if (depth === 0 && (ch === ';' || ch === '\n')) return i
  }
  return text.length - 1
}

const DEFS = {
  ts: [
    { kind: 'function', re: /^[ \t]*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm },
    { kind: 'class', re: /^[ \t]*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm },
    { kind: 'function', arrow: true, re: /^[ \t]*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::\s*[^=\n]+)?=>/gm },
    { kind: 'function', re: /^[ \t]*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\b/gm },
    { kind: 'interface', re: /^[ \t]*(?:export\s+)?(?:declare\s+)?(?:interface|enum)\s+([A-Za-z_$][\w$]*)/gm },
    { kind: 'method', method: true, re: /^[ \t]*(?:(?:public|private|protected|static|async|readonly|override|abstract|get|set)\s+)*\*?\s*(#?[A-Za-z_$][\w$]*)\s*(?:<[^>\n]*>)?\s*\(/gm },
  ],
  go: [
    { kind: 'function', re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm },
    { kind: 'type', re: /^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/gm },
  ],
  rs: [
    { kind: 'function', re: /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)/gm },
    { kind: 'type', re: /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|union)\s+([A-Za-z_]\w*)/gm },
    { kind: 'impl', re: /^[ \t]*impl(?:<[^>]*>)?\s+(?:[\w:<>, ]+\s+for\s+)?([A-Za-z_]\w*)/gm },
  ],
  java: [
    { kind: 'class', re: /^[ \t]*(?:(?:public|private|protected|internal|static|final|abstract|sealed|open|data|partial)\s+)*(?:class|interface|enum|record|object|struct)\s+([A-Za-z_]\w*)/gm },
    { kind: 'method', method: true, re: /^[ \t]*(?:(?:public|private|protected|internal|static|final|override|suspend|abstract|synchronized|async|virtual|open|fun|func)\s+)+(?:[\w<>[\],.?\s]+\s+)?([A-Za-z_]\w*)\s*(?:<[^>\n]*>)?\s*\(/gm },
  ],
  c: [
    { kind: 'function', method: true, re: /^[A-Za-z_][\w\s*&:<>,]*?\b([A-Za-z_]\w*)\s*\([^;{]*\)\s*(?:const\s*)?\{/gm },
    { kind: 'type', re: /^[ \t]*(?:typedef\s+)?(?:struct|class|enum|union)\s+([A-Za-z_]\w*)\s*\{/gm },
  ],
}

function pythonSymbols(text) {
  const lines = text.split('\n')
  const out = []
  const re = /^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i])
    if (!m) continue
    const indent = m[1].length
    let start = i
    while (start > 0 && /^\s*@/.test(lines[start - 1])) start--
    let end = i
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]
      if (!l.trim() || /^\s*#/.test(l)) continue
      if (l.length - l.trimStart().length <= indent) break
      end = j
    }
    out.push({ name: m[3], kind: m[2] === 'def' ? 'function' : 'class', start: start + 1, end: end + 1, lang: 'py' })
  }
  return out
}

function ctagsSymbols(file) {
  const r = spawnSync('ctags', ['--output-format=json', '--fields=+ne', '-f', '-', file], { encoding: 'utf8' })
  if (r.status !== 0) return null
  return r.stdout.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } })
    .filter(t => t && t._type === 'tag' && t.line)
    .map(t => ({ name: t.name, kind: t.kind, start: t.line, end: t.end ?? t.line, lang: langOf(file) }))
}

// All symbols in a file: [{ name, qname, kind, start, end, lang }] with 1-based inclusive lines.
function symbolsOf(text, file, { useCtags = process.env.JSTACK_SYMBOLS === 'ctags' } = {}) {
  const lang = langOf(file)
  if (!lang) return []
  let syms = null
  if (useCtags) syms = ctagsSymbols(file)
  if (!syms) {
    if (lang === 'py') syms = pythonSymbols(text)
    else {
      syms = []
      const starts = lineStarts(text)
      const seen = new Set()
      for (const d of DEFS[lang] ?? []) {
        d.re.lastIndex = 0
        let m
        while ((m = d.re.exec(text))) {
          const name = m[1]
          if (KEYWORDS.has(name)) continue
          const nameAt = m.index + m[0].lastIndexOf(name)
          const startLine = lineAt(starts, m.index + (m[0].length - m[0].trimStart().length))
          if (seen.has(startLine)) continue
          const b = bodyStart(text, nameAt + name.length, lang, { arrow: !!d.arrow })
          if (!b) continue
          if (d.method) {
            // A method or C function definition, not a call: the body brace follows the parameter list directly
            // (or after a return type / throws clause) before any ; on the way.
            if (b.expr !== undefined) continue
            const openParen = text.indexOf('(', nameAt)
            const closeParen = matchParen(text, openParen, lang)
            if (openParen < 0 || closeParen < 0 || closeParen > b.open) continue
            const tail = text.slice(closeParen + 1, b.open)
            if (/[;\n]\s*\S[^\n]*\n/.test(tail) || !/^\s*(?::[^{;]*|throws[^{;]*|const\s*|->[^{;]*)?\s*$/.test(tail)) continue
          }
          const endIdx = b.open !== undefined ? matchBrace(text, b.open, lang) : exprEnd(text, b.expr, lang)
          seen.add(startLine)
          syms.push({ name: name.replace(/^#/, ''), kind: d.kind, start: startLine, end: lineAt(starts, endIdx), lang })
        }
      }
    }
  }
  syms.sort((a, b) => a.start - b.start || b.end - a.end)
  for (const s of syms) {
    const parents = syms.filter(p => p !== s && p.start <= s.start && p.end >= s.end && (p.start < s.start || p.end > s.end) && ['class', 'impl', 'type', 'interface'].includes(p.kind))
    parents.sort((a, b) => a.start - b.start)
    s.qname = [...parents.map(p => p.name), s.name].join('.')
  }
  return syms
}

// The innermost symbol whose range contains `line`, or null.
function enclosingSymbol(text, file, line) {
  const hits = symbolsOf(text, file).filter(s => s.start <= line && s.end >= line)
  hits.sort((a, b) => (a.end - a.start) - (b.end - b.start))
  return hits[0] ?? null
}

// Finds a symbol by qualified name first, then by bare name when that is unique. Returns null or the symbol.
function findSymbol(text, file, name) {
  const syms = symbolsOf(text, file)
  const q = syms.filter(s => s.qname === name)
  if (q.length === 1) return q[0]
  const n = syms.filter(s => s.name === name)
  return n.length === 1 ? n[0] : (q[0] ?? null)
}

function sliceLines(text, start, end) {
  return text.split('\n').slice(start - 1, end).join('\n')
}

// Strips comments, collapses whitespace, drops trailing commas and JS semicolons. Formatting-only edits keep the result.
function normalize(code, lang = 'ts') {
  let out = ''
  for (let i = 0; i < code.length; i++) {
    const s = skipLiteral(code, i, lang)
    if (s !== i) {
      const lit = code.slice(i, s)
      const isComment = lang === 'py' ? lit.startsWith('#') : (lit.startsWith('//') || lit.startsWith('/*'))
      out += isComment ? ' ' : lit
      i = s - 1
      continue
    }
    out += code[i]
  }
  out = out.replace(/\s+/g, ' ')
  out = out.replace(/ ?([^\w\s$'"`]) ?/g, '$1')
  out = out.replace(/,([)\]}])/g, '$1')
  if (lang === 'ts') out = out.replace(/;/g, '')
  return out.trim()
}

function hashText(s) {
  return 'sha256:' + crypto.createHash('sha256').update(s).digest('hex').slice(0, 16)
}

function bodyHash(code, lang) {
  return hashText(normalize(code, lang))
}

function tokensOf(normalized) {
  return normalized.match(/[A-Za-z_$][\w$]*|\d+|\S/g) ?? []
}

function fnv(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h
}

// Winnowing fingerprints (Schleimer, Wilkerson, Aiken, SIGMOD 2003): hashes of k-token grams, keeping the minimum
// of every window of w grams. Robust to small edits, so a moved or renamed body still matches.
function fingerprints(code, lang, k = 5, w = 4) {
  const toks = tokensOf(normalize(code, lang))
  if (toks.length < k) return new Set(toks.length ? [fnv(toks.join(' '))] : [])
  const grams = []
  for (let i = 0; i + k <= toks.length; i++) grams.push(fnv(toks.slice(i, i + k).join(' ')))
  if (grams.length <= w) return new Set(grams)
  const out = new Set()
  for (let i = 0; i + w <= grams.length; i++) out.add(Math.min(...grams.slice(i, i + w)))
  return out
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 1
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

function coverage(old, part) {
  if (!old.size) return 0
  let inter = 0
  for (const x of old) if (part.has(x)) inter++
  return inter / old.size
}

export { langOf, symbolsOf, enclosingSymbol, findSymbol, sliceLines, normalize, hashText, bodyHash, fingerprints, jaccard, coverage, lineStarts, lineAt, skipLiteral }
