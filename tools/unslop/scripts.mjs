// Built-in "script" engine checks: defects that are a property of several files or of the diff, not of one line.
// Each check gets ctx = { files: [{ path, text, added }], listFiles(globs) -> [{ path, text }], diffStatus: Map }
// and returns hits [{ path, line, snippet, detail }].
import fs from 'node:fs'
import path from 'node:path'
import { matchAny } from './rules.mjs'

const LOCALE = /^[a-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/

function flatKeys(obj, prefix = '') {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [prefix.slice(0, -1)]
  return Object.entries(obj).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? flatKeys(v, `${prefix}${k}.`) : [`${prefix}${k}`]))
}

function keyLine(text, key) {
  const last = key.split('.').pop()
  const i = text.indexOf(`"${last}"`)
  return i < 0 ? 1 : text.slice(0, i).split('\n').length
}

function catalogGroup(p) {
  const parts = p.split('/')
  const file = parts[parts.length - 1]
  const dir = parts[parts.length - 2]
  if (dir && LOCALE.test(dir)) return { key: [...parts.slice(0, -2), '*', file].join('/'), locale: dir }
  const stem = file.replace(/\.json$/, '')
  if (LOCALE.test(stem)) return { key: [...parts.slice(0, -1), '*.json'].join('/'), locale: stem }
  return null
}

const SCRIPTS = {
  // A migration that was already committed on the base is edited, renamed or deleted in this diff.
  'migration-edited'(ctx, rule) {
    const dirs = rule.options?.dirs ?? ['**/migrations/**']
    const hits = []
    for (const [p, status] of ctx.diffStatus ?? []) {
      if (!matchAny(p, dirs) || !/^[MDR]/.test(status)) continue
      hits.push({ path: p, line: 1, snippet: `${status} ${p}`, detail: `applied migration ${status === 'D' ? 'deleted' : status.startsWith('R') ? 'renamed' : 'edited'}; add a new migration instead` })
    }
    return hits
  },

  // Two migrations share a timestamp prefix: they apply in an undefined order, and one may be skipped.
  'migration-stamp-dup'(ctx, rule) {
    const dirs = rule.options?.dirs ?? ['**/migrations/**']
    const all = ctx.listFiles(dirs)
    const groups = new Map()
    for (const f of all) {
      const parts = f.path.split('/')
      const mi = parts.findIndex(x => /migrations?$/i.test(x))
      if (mi < 0 || !parts[mi + 1]) continue
      const entry = parts.slice(0, mi + 2).join('/')
      const stamp = /^(\d{8,14})/.exec(parts[mi + 1])?.[1]
      if (!stamp) continue
      const key = `${parts.slice(0, mi + 1).join('/')}|${stamp}`
      if (!groups.has(key)) groups.set(key, new Set())
      groups.get(key).add(entry)
    }
    const touched = new Set(ctx.files.map(f => f.path))
    const hits = []
    for (const [key, entries] of groups) {
      if (entries.size < 2) continue
      const list = [...entries].sort()
      for (const e of list) {
        const mine = [...touched].find(t => t === e || t.startsWith(e + '/'))
        if (!ctx.all && !mine) continue
        hits.push({ path: mine ?? e, line: 1, snippet: e, detail: `stamp ${key.split('|')[1]} shared by ${list.join(', ')}` })
      }
    }
    return hits
  },

  // A locale catalog lacks keys its sibling locales have (merges that took one side whole lose keys like this).
  'catalog-parity'(ctx, rule) {
    const globs = rule.files ?? ['**/messages/**/*.json', '**/locales/**/*.json', '**/i18n/**/*.json']
    const all = ctx.listFiles(globs)
    const groups = new Map()
    for (const f of all) {
      const g = catalogGroup(f.path)
      if (!g) continue
      let keys
      try { keys = new Set(flatKeys(JSON.parse(f.text))) } catch { continue }
      if (!groups.has(g.key)) groups.set(g.key, [])
      groups.get(g.key).push({ ...f, locale: g.locale, keys })
    }
    const touched = new Set(ctx.files.map(f => f.path))
    const hits = []
    for (const members of groups.values()) {
      if (members.length < 2 || (!ctx.all && !members.some(m => touched.has(m.path)))) continue
      const union = new Set(members.flatMap(m => [...m.keys]))
      for (const m of members) {
        const missing = [...union].filter(k => !m.keys.has(k))
        if (!missing.length) continue
        const other = members.find(o => o !== m && o.keys.has(missing[0]))
        hits.push({ path: m.path, line: 1, snippet: missing.slice(0, 5).join(', '), detail: `${missing.length} key(s) missing in ${m.locale}${other ? ` (present in ${other.locale}, e.g. line ${keyLine(other.text, missing[0])} of ${path.posix.basename(other.path)})` : ''}: ${missing.slice(0, 8).join(', ')}` })
      }
    }
    return hits
  },

  // A Markdown link on an added line points at a repository path that does not exist (moved, renamed or never there).
  'md-dead-link'(ctx, rule) {
    const globs = rule.files ?? ['**/*.md']
    const LINK = /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g
    const hits = []
    for (const f of ctx.files) {
      if (!matchAny(f.path, globs)) continue
      let fenced = false
      f.text.split('\n').forEach((l, i) => {
        if (/^\s*(?:```|~~~)/.test(l)) { fenced = !fenced; return }
        if (fenced || (f.added && !f.added.has(i + 1))) return
        for (const m of l.replace(/`[^`]*`/g, '').matchAll(LINK)) {
          const raw = m[1]
          if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('#') || raw.startsWith('/') || raw.includes('{{')) continue
          let target = raw.split('#')[0].split('?')[0]
          try { target = decodeURI(target) } catch {}
          if (!target) continue
          const rel = path.posix.normalize(path.posix.join(path.posix.dirname(f.path), target))
          if (rel.startsWith('..')) continue
          if (!fs.existsSync(path.join(ctx.base, rel))) hits.push({ path: f.path, line: i + 1, snippet: l.trim(), detail: `links to ${rel}, which does not exist` })
        }
      })
    }
    return hits
  },

  // A Messages API call with cache_control at the top level of the request (automatic caching). The breakpoint
  // lands on the last block; when that block is unique per call, every call writes the whole prompt at the write
  // premium and nothing reads it back. Brackets, strings and comments are walked so only a key of the request
  // itself counts, never one on a system or content block.
  'cache-top-level'(ctx, rule) {
    const globs = rule.files ?? ['**/*.{ts,tsx,js,jsx,mjs,cjs,py}']
    const hits = []
    for (const f of ctx.files) {
      if (!matchAny(f.path, globs)) continue
      const py = f.path.endsWith('.py')
      for (const at of topLevelCacheControl(f.text, py)) {
        const line = f.text.slice(0, at).split('\n').length
        if (f.added && !f.added.has(line)) continue
        hits.push({ path: f.path, line, snippet: f.text.split('\n')[line - 1].trim(), detail: 'request-level cache_control: the breakpoint goes on the last block' })
      }
    }
    return hits
  },
}

const MESSAGES_CALL = /\.messages\.(?:create|stream|parse)\s*\(\s*$/
const CLOSE = { ')': '(', ']': '[', '}': '{' }

// Offsets of request-level cache_control keys. A bracket frame is a request when it holds a `messages` key, or when
// it is a messages call's argument object (JS/TS) or the call's own keyword arguments (Python). Keys count only at
// the start of an entry, so values, nested blocks, strings and comments never do.
function topLevelCacheControl(text, py) {
  const out = []
  const frames = []
  let last = ''
  let i = 0
  const callFrame = at => MESSAGES_CALL.test(text.slice(Math.max(0, at - 80), at))
  const request = f => f && f.keys.has('cache_control') && (f.call || (f.open === '{' && f.keys.has('messages')))
  const destructured = after => !py && /^\s*\)?\s*=(?!=)/.test(text.slice(after, after + 20))
  while (i < text.length) {
    const ch = text[i]
    const top = frames[frames.length - 1]
    const entryStart = top && (last === top.open || last === ',')
    if (ch === '"' || ch === "'" || ch === '`') {
      const start = i
      const end = py && text.startsWith(ch.repeat(3), i) ? ch.repeat(3) : ch
      let j = i + end.length
      while (j < text.length && !text.startsWith(end, j)) j += text[j] === '\\' ? 2 : 1
      const body = text.slice(i + end.length, j)
      i = j + end.length
      if (entryStart && top.open === '{' && ch !== '`' && /^\s*:/.test(text.slice(i, i + 40))) top.keys.set(body, start)
      last = ch
      continue
    }
    if ((py && ch === '#') || (!py && ch === '/' && text[i + 1] === '/')) { const nl = text.indexOf('\n', i); i = nl < 0 ? text.length : nl; continue }
    if (!py && ch === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? text.length : e + 2; continue }
    if (ch === '(' || ch === '[' || ch === '{') {
      const parent = frames[frames.length - 1]
      const call = py ? ch === '(' && callFrame(i + 1) : ch === '{' && parent?.open === '(' && parent.callOpen && last === '('
      frames.push({ open: ch, keys: new Map(), call, callOpen: ch === '(' && callFrame(i + 1) })
      last = ch
      i++
      continue
    }
    if (CLOSE[ch]) {
      const f = frames.pop()
      if (request(f) && !(f.open === '{' && destructured(i + 1))) out.push(f.keys.get('cache_control'))
      last = ch
      i++
      continue
    }
    if (/[A-Za-z_$]/.test(ch) && !/[\w$]/.test(text[i - 1] ?? '')) {
      const m = /[A-Za-z_$][\w$]*/y
      m.lastIndex = i
      const name = m.exec(text)[0]
      const rest = text.slice(i + name.length, i + name.length + 40)
      if (entryStart) {
        if (top.open === '{' && (/^\s*:/.test(rest) || (!py && /^\s*[,}]/.test(rest)))) top.keys.set(name, i)
        else if (py && top.open === '(' && /^\s*=(?!=)/.test(rest)) top.keys.set(name, i)
      }
      i += name.length
      last = 'w'
      continue
    }
    if (!/\s/.test(ch)) last = ch
    i++
  }
  return out.sort((a, b) => a - b)
}

export { SCRIPTS, flatKeys, catalogGroup, topLevelCacheControl }
