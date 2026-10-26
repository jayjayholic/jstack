#!/usr/bin/env node
// jstack guard hooks. One file, entry points (see hooks.json):
//   pre      PreToolUse on Bash|PowerShell|Grep|Glob|LSP: heavy-lock, scan, stash and branch-delete guards, block log
//   post     PostToolUse on Bash|PowerShell: ends the call's time window (process ownership, jstack-calls.mjs)
//   cleanup  SubagentStop (and Stop when opted in): kills what the agent's own tool calls left running in its
//            worktrees and closes the automation browsers it left open; waits while its background work runs
// Hooks run through run-hook.mjs, which turns any crash (even a syntax error here) into exit 0 + a guard-log line.
// CLI: keep-browser [pid...] [--reason text] [--off]   browser-watch [--once] [--every 60] [--grace 600] [--install]
// Everything is a no-op unless ~/.jstack/guards.json (or $JSTACK_GUARDS_CONFIG) has a project whose roots
// contain the session's project dir or cwd. No dependencies, Node 18+.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'
import * as browsers from './jstack-browsers.mjs'
import * as calls from './jstack-calls.mjs'

// Child processes run from the hook's own folder, never the repo: Windows resolves a bare
// command name against the current directory first, so a repo could plant git.exe or powershell.exe.
const HOOK_DIR = path.dirname(fileURLToPath(import.meta.url))

const WIN = process.platform === 'win32'
const DEFAULT_WRAPPERS = ['tc_run', 'heavy_capped', 'heavy_acquire']
const DEFAULT_HEAVY = [
  { kind: 'typecheck', re: '^(?:(?:bunx|npx|pnpx)\\s+|(?:pnpm|yarn)\\s+(?:exec|dlx)\\s+)?(?:tsc|tsgo|vue-tsc)(?:\\s|$)' },
  { kind: 'typecheck', re: '^node(?:\\s+-\\S+)*\\s+\\S*typescript\\w*[\\\\/]bin[\\\\/]tsc(?:\\s|$)' },
  { kind: 'typecheck', re: '^(?:bun|npm|pnpm|yarn)\\s+(?:run\\s+)?(?:typecheck|type-check|tsc)(?:[\\s:]|$)' },
  { kind: 'build', re: '^(?:(?:bunx|npx|pnpx)\\s+)?next\\s+build(?:\\s|$)' },
  { kind: 'build', re: '^node(?:\\s+-\\S+)*\\s+\\S*next[\\\\/]dist[\\\\/]bin[\\\\/]next\\s+build(?:\\s|$)' },
  { kind: 'build', re: '^(?:bun|npm|pnpm|yarn)\\s+run\\s+build(?:[\\s:]|$)' },
  { kind: 'build', re: '^(?:pnpm|yarn)\\s+build(?:[\\s:]|$)' },
  { kind: 'build', re: '^(?:(?:bunx|npx)\\s+)?turbo\\s+(?:run\\s+)?(?:build|typecheck)(?:\\s|$)' },
  { kind: 'install', re: '^(?:bun|npm|pnpm|yarn)\\s+(?:install|i|ci)(?:\\s|$)' },
  { kind: 'worktree-remove', re: '^git(?:\\s+-c\\s+\\S+)*\\s+worktree\\s+remove(?:\\s|$)' },
  { kind: 'worktree-remove', re: '^robocopy\\s.*\\s/mir(?:\\s|$)' },
]
const LIGHT_FLAGS = /\s(?:--version|-v|--help|-h|--init)(?:\s|$)/
const DEFAULT_KILL_NAMES = ['node', 'bun', 'bash', 'sh', 'tail', 'cmd', 'powershell', 'pwsh']
const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'LSP'])

// ---------- paths ----------

function norm(p) {
  if (!p) return ''
  let s = String(p).replace(/\\/g, '/')
  const msys = /^\/([a-zA-Z])(\/|$)/.exec(s)
  if (WIN && msys) s = `${msys[1]}:/${s.slice(3)}`
  if (/^[a-zA-Z]:$/.test(s)) s += '/'
  s = s.replace(/\/+$/, '') || '/'
  if (/^[a-zA-Z]:$/.test(s)) s += '/'
  return WIN ? s.toLowerCase() : s
}

// A whole command line in the same form as norm(): forward slashes, MSYS /c/ drives, lowercase on Windows.
function normCmd(c) {
  let s = String(c).replace(/\\/g, '/')
  if (WIN) s = s.replace(/(^|[\s"'=;])\/([a-zA-Z])\//g, '$1$2:/').toLowerCase()
  return s
}

function resolveFrom(cwd, tok) {
  let t = tok.replace(/^['"]|['"]$/g, '')
  if (t === '~' || t.startsWith('~/')) t = os.homedir() + t.slice(1)
  const n = norm(t)
  const abs = WIN ? /^[a-z]:\//.test(n) || /^[a-z]:\/?$/.test(n) : n.startsWith('/')
  return abs ? n : norm(path.resolve(cwd, t))
}

function isInside(child, parent) {
  if (!parent) return false
  if (child === parent) return true
  return child.startsWith(parent.endsWith('/') ? parent : parent + '/')
}

function exists(p, kind) {
  try {
    const s = fs.statSync(p)
    return kind === 'dir' ? s.isDirectory() : kind === 'file' ? s.isFile() : true
  } catch { return false }
}

// Walks up to the nearest folder holding .git. Returns { root, linked } (linked = a git worktree, .git is a file).
function gitTop(p) {
  let cur = p
  for (let i = 0; i < 40 && cur; i++) {
    const g = path.join(cur, '.git')
    if (exists(g, 'dir')) return { root: norm(cur), linked: false }
    if (exists(g, 'file')) return { root: norm(cur), linked: true }
    const up = path.dirname(cur)
    if (up === cur) break
    cur = up
  }
  return null
}

// ---------- config ----------

function configPath() {
  return process.env.JSTACK_GUARDS_CONFIG || path.join(os.homedir(), '.jstack', 'guards.json')
}

function loadProject(payload, env = process.env) {
  let cfg
  try { cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8')) } catch { return null }
  const here = [env.CLAUDE_PROJECT_DIR, payload.cwd].filter(Boolean).map(norm)
  for (const p of cfg.projects ?? []) {
    if ((p.roots ?? []).some(r => here.some(h => isInside(h, norm(r))))) return { ...p, logFile: cfg.log }
  }
  return null
}

// ---------- shell parsing ----------

function stripHeredocs(cmd) {
  const lines = cmd.split(/\r?\n/)
  const out = []
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i])
    const m = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/.exec(lines[i])
    if (!m) continue
    while (i + 1 < lines.length && lines[i + 1].trim() !== m[1]) i++
  }
  return out.join('\n')
}

// Splits on ; & | newline ( ) { } and backticks outside quotes. Each segment keeps its quotes.
function segments(cmd) {
  const segs = []
  let cur = '', q = null
  for (const ch of stripHeredocs(cmd)) {
    if (q) { cur += ch; if (ch === q) q = null; continue }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue }
    if (';&|\n(){}`'.includes(ch)) { if (cur.trim()) segs.push(cur.trim()); cur = ''; continue }
    cur += ch
  }
  if (cur.trim()) segs.push(cur.trim())
  return segs
}

function tokens(seg) {
  const out = []
  let cur = '', q = null, any = false
  for (const ch of seg) {
    if (q) { if (ch === q) q = null; else cur += ch; continue }
    if (ch === '"' || ch === "'") { q = ch; any = true; continue }
    if (/\s/.test(ch)) { if (cur || any) out.push(cur); cur = ''; any = false; continue }
    cur += ch
  }
  if (cur || any) out.push(cur)
  return out
}

const PREFIX = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*|time|nohup|exec|command|env|sudo)$/

// The segment with env assignments and wrappers like `time` dropped and the program reduced to its basename.
function head(seg) {
  const quoted = seg.replace(/"[^"]*"|'[^']*'/g, 'Q')
  const toks = quoted.split(/\s+/).filter(Boolean)
  while (toks.length && PREFIX.test(toks[0])) toks.shift()
  if (!toks.length) return ''
  toks[0] = toks[0].replace(/^.*[\\/]/, '').replace(/\.(?:cmd|exe|ps1)$/i, '')
  return toks.join(' ')
}

function shellPayloads(seg) {
  if (!/^(?:bash|sh|zsh|cmd|powershell|pwsh)(?:\.exe)?(?:\s.*)?\s(?:-c|\/c|-Command|-command)\s/i.test(seg + ' ')) return []
  return [...seg.matchAll(/"([^"]*)"|'([^']*)'/g)].map(m => m[1] ?? m[2])
}

function walkSegments(cmd, visit, depth = 0) {
  for (const seg of segments(cmd)) {
    visit(seg)
    if (depth < 2) for (const inner of shellPayloads(seg)) walkSegments(inner, visit, depth + 1)
  }
}

// ---------- guard 1: heavy commands only through the lock ----------

const HEAVY_BINS = /^(?:next|tsc|tsgo|vue-tsc|turbo)$/
const LAUNCHERS = /^(?:bunx|npx|pnpx|bun|pnpm|yarn|npm)$/
const LAUNCHER_WORDS = /^(?:x|exec|dlx|run)$/
const LAUNCHER_FLAGS = /^(?:--bun|-y|--yes|-s|--silent|--)$/

// Every form a segment's program can take: the plain head, plus the bare tool behind a launcher
// (`bun x next build`, `npx -y tsc`, `npm exec -- tsc`, `pnpm next build`) and behind `timeout`/`nice`.
function heavyHeads(seg) {
  const t = head(seg).split(' ').filter(Boolean)
  for (let guard = 0; t.length && guard < 6; guard++) {
    if (t[0] === 'timeout') { t.shift(); while (t[0]?.startsWith('-')) t.shift(); t.shift(); continue }
    if (t[0] === 'nice') { t.shift(); if (t[0] === '-n') t.splice(0, 2); else if (/^-/.test(t[0] ?? '')) t.shift(); continue }
    if (t[0] && PREFIX.test(t[0])) { t.shift(); continue }
    break
  }
  if (!t.length) return []
  t[0] = t[0].replace(/^.*[\\/]/, '').replace(/\.(?:cmd|exe|ps1)$/i, '')
  const heads = [t.join(' ')]
  if (LAUNCHERS.test(t[0])) {
    heads.push([t[0], ...t.slice(1).filter(x => !LAUNCHER_FLAGS.test(x))].join(' '))
    let i = 1
    while (i < t.length && (LAUNCHER_WORDS.test(t[i]) || t[i].startsWith('-'))) i++
    const bin = (t[i] ?? '').replace(/^.*[\\/]/, '')
    if (HEAVY_BINS.test(bin)) heads.push([bin, ...t.slice(i + 1)].join(' '))
  }
  return heads
}

// `tsc --noEmit src/one.ts`: one explicit source file and no project, a small check, not a full typecheck.
function singleFileCheck(h) {
  const t = h.split(' ')
  if (!/^(?:tsc|tsgo|vue-tsc)$/.test(t[0])) return false
  if (t.some(x => /^(?:-p|--project|-b|--build)$/.test(x))) return false
  const files = t.slice(1).filter(x => !x.startsWith('-') && /\.(?:ts|tsx|mts|cts)$/i.test(x))
  return files.length === 1
}

function cdTargets(cmd, cwd) {
  return [...cmd.matchAll(/(?:^|[;&|]\s*)(?:cd|pushd|Set-Location)\s+("[^"]+"|'[^']+'|\S+)/g)].map(m => resolveFrom(cwd, m[1]))
}

function lockDirs(conf, env) {
  const d = conf.lockDir ?? env.JSTACK_LOCK_DIR ?? path.join(os.homedir(), '.jstack', 'heavy-lock')
  return (Array.isArray(d) ? d : [d]).map(x => resolveFrom(os.homedir(), x))
}

// The heavy slot is already held for this worktree (its owner line ends "@ <cwd>"): the caller is inside its slot,
// e.g. a train that ran heavy_acquire in an earlier call. Unreadable or missing owner files mean "not held".
function slotHeldHere(conf, roots, env) {
  if (!roots.length) return false
  for (const dir of lockDirs(conf, env)) {
    let line = ''
    try { line = fs.readFileSync(path.join(dir, 'owner'), 'utf8') } catch { continue }
    const m = /@\s+(.+?)\s*$/.exec(line.trim())
    if (!m) continue
    const owner = gitTop(resolveFrom(os.homedir(), m[1]))
    if (owner && roots.includes(owner.root)) return true
  }
  return false
}

function heavyCheck(cmd, project, cwd = process.cwd(), env = process.env) {
  const conf = project.heavyLock ?? {}
  if (conf.enabled === false) return null
  const wrappers = conf.wrappers ?? DEFAULT_WRAPPERS
  if (wrappers.some(w => new RegExp(`(?:^|[^\\w-])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^\\w-]|$)`).test(cmd))) return null
  const rules = [...(conf.patterns ?? DEFAULT_HEAVY), ...(conf.extraPatterns ?? [])].map(r => ({ kind: r.kind ?? 'build', re: new RegExp(r.re, 'i') }))
  let hit = null
  walkSegments(cmd, seg => {
    if (hit) return
    const heads = heavyHeads(seg)
    if (heads.some(h => LIGHT_FLAGS.test(' ' + h + ' ') || singleFileCheck(h))) return
    for (const h of heads) {
      const r = rules.find(x => x.re.test(h))
      if (r) { hit = { kind: r.kind, segment: seg }; return }
    }
  })
  if (!hit) return null
  if (hit.kind !== 'worktree-remove') {
    const roots = [...new Set([cwd, ...cdTargets(cmd, cwd)].map(p => gitTop(p)?.root).filter(Boolean))]
    if (!roots.length) return null
    if (conf.holderPasses !== false && slotHeldHere(conf, roots, env)) return null
  }
  if (!hit) return null
  const lock = conf.lockScript ?? '<jstack tools>/heavy-lock.sh'
  const tools = lock.replace(/[\\/][^\\/]*$/, '')
  const tpl = (conf.suggest ?? {})[hit.kind] ?? (hit.kind === 'typecheck'
    ? `source ${lock} && tc_run "{cmd}"`
    : hit.kind === 'worktree-remove'
      ? `node ${tools}/worktree-deps.mjs remove <worktree path> --delete-branch`
      : `source ${lock} && heavy_acquire ${hit.kind} && heavy_capped "{cmd}"; heavy_release`)
  const suggestion = tpl.replace('{cmd}', hit.segment.replace(/"/g, '\\"'))
  if (hit.kind === 'worktree-remove') {
    const reason = [
      `jstack worktree guard: \`${hit.segment}\` follows NTFS junctions on Windows (seen with Git for Windows 2.40 and robocopy /MIR) and deletes what they point at: the shared node_modules and generated stores every other worktree links to.`,
      `Run instead:  ${suggestion}`,
      'It unlinks every junction first, then runs git worktree remove.',
    ].join('\n')
    return { guard: 'heavy-lock', reason, suggestion }
  }
  const reason = [
    `jstack heavy-lock guard: \`${hit.segment}\` is a heavy ${hit.kind} (5-8 GB each) and must run inside the machine-wide lock, or two of them at once take the machine down.`,
    `Run it again as:  ${suggestion}`,
    `Same command, same result; it just waits for its slot and a hard RAM cap. Don't split it, rename it or hide it in a script to dodge this check.`,
    conf.note ?? '',
  ].filter(Boolean).join('\n')
  return { guard: 'heavy-lock', reason, suggestion }
}

// ---------- guard 2: no recursive scans over the repo, worktrees or node_modules ----------

function scanTargets(h, toks, cwd) {
  const prog = h.split(' ')[0].toLowerCase()
  const args = toks.slice(1)
  const flags = args.filter(a => a.startsWith('-'))
  let kind = null, pathArgs = []
  if (/^(?:grep|egrep|fgrep)$/.test(prog)) {
    const rec = flags.some(f => /^-[a-zA-Z]*[rR]/.test(f) && !f.startsWith('--') || f === '--recursive' || f === '--dereference-recursive')
    if (!rec) return null
    kind = 'grep'
    const hasE = flags.some(f => /^-[a-zA-Z]*[ef]$/.test(f) || f.startsWith('--regexp') || f.startsWith('--file'))
    const plain = []
    for (let i = 0; i < args.length; i++) {
      const a = args[i]
      if (a.startsWith('-')) { if (/^-[a-zA-Z]*[efmABC]$/.test(a)) i++; continue }
      plain.push(a)
    }
    pathArgs = hasE ? plain : plain.slice(1)
  } else if (prog === 'find') {
    const depth = args.indexOf('-maxdepth')
    if (depth >= 0 && Number(args[depth + 1]) <= 2) return null
    kind = 'find'
    for (const a of args) { if (/^[-(!]/.test(a)) break; pathArgs.push(a) }
  } else if (prog === 'du') {
    kind = 'du'
    pathArgs = args.filter(a => !a.startsWith('-'))
  } else if (/^(?:ls|tree)$/.test(prog)) {
    if (prog === 'ls' && !flags.some(f => /^-[a-zA-Z]*R/.test(f) || f === '--recursive')) return null
    kind = prog
    pathArgs = args.filter(a => !a.startsWith('-'))
  } else if (/^(?:get-childitem|gci|dir|select-string|sls)$/.test(prog)) {
    if (!flags.some(f => /^-(?:r|re|rec|recu|recur|recurs|recurse)$/i.test(f)) && !args.some(a => /^\/s$/i.test(a))) return null
    kind = 'Get-ChildItem -Recurse'
    for (let i = 0; i < args.length; i++) {
      const a = args[i]
      if (/^-(?:path|literalpath)$/i.test(a)) { pathArgs.push(args[++i]); continue }
      if (a.startsWith('-')) { if (/^-(?:filter|include|exclude|pattern|depth|encoding)$/i.test(a)) { if (/^-depth$/i.test(a) && Number(args[i + 1]) <= 2) return null; i++ } continue }
      if (prog === 'select-string' || prog === 'sls') continue
      pathArgs.push(a)
    }
  } else return null
  const dirs = pathArgs.filter(Boolean).map(a => {
    const g = a.search(/[*?[]/)
    const base = g >= 0 ? a.slice(0, a.lastIndexOf('/', g) + 1 || 0) || '.' : a
    return resolveFrom(cwd, base)
  })
  return { kind, dirs: dirs.length ? dirs : [norm(cwd)] }
}

function tooBroad(dir, project, cwd) {
  if (/(?:^|\/)node_modules(?:\/|$)/.test(dir)) return 'node_modules'
  if (/(?:^|\/)\.worktrees$/.test(dir) || /\/\.claude\/worktrees$/.test(dir)) return 'the worktrees folder'
  for (const w of project.scans?.extraRoots ?? []) if (norm(w) === dir) return 'a configured root'
  if (exists(path.join(dir, '.git'))) return 'a whole repo checkout'
  const tops = [gitTop(cwd)?.root, ...(project.roots ?? []).map(norm)].filter(Boolean)
  if (tops.some(t => isInside(t, dir))) return 'a folder above the repo'
  return null
}

function scanCheck(cmd, project, cwd) {
  if (project.scans?.enabled === false) return null
  let here = cwd, hit = null
  walkSegments(cmd, seg => {
    if (hit) return
    const toks = tokens(seg)
    while (toks.length && PREFIX.test(toks[0])) toks.shift()
    if (!toks.length) return
    const prog = toks[0].replace(/^.*[\\/]/, '').toLowerCase()
    if (/^(?:cd|pushd|set-location|sl|chdir)$/.test(prog) && toks[1]) { here = resolveFrom(here, toks[1]); return }
    const t = scanTargets(head(seg), toks, here)
    if (!t) return
    for (const d of t.dirs) {
      const why = tooBroad(d, project, here)
      if (why) { hit = { kind: t.kind, dir: d, why, segment: seg }; return }
    }
  })
  if (!hit) return null
  const suggestion = 'the Grep or Glob tool (or `git grep`, `git ls-files`, LSP), or the same command on a specific subfolder'
  const reason = [
    `jstack scan guard: \`${hit.segment}\` walks ${hit.why} (${hit.dir}). With hundreds of worktrees and node_modules that's minutes of disk and GBs of file cache.`,
    `Use ${suggestion}. The Grep and Glob tools skip ignored files and are fast. A recursive grep/find inside a small folder like src/lib/chat is fine; node_modules never is.`,
  ].join('\n')
  return { guard: 'scan', reason, suggestion }
}

// Once per agent: a scoped `grep -r` passes, but the Grep tool (ripgrep) or `git grep` is 2-3x faster and skips
// ignored files. A note, never a block, and never "alias grep to rg": rg's regex differs from grep's BRE.
function scopedGrep(cmd, project, cwd) {
  if (project.scans?.enabled === false || project.scans?.nudge === false) return false
  let here = cwd, hit = false
  walkSegments(cmd, seg => {
    if (hit) return
    const toks = tokens(seg)
    while (toks.length && PREFIX.test(toks[0])) toks.shift()
    if (!toks.length) return
    const prog = toks[0].replace(/^.*[\\/]/, '').toLowerCase()
    if (/^(?:cd|pushd|set-location|sl|chdir)$/.test(prog) && toks[1]) { here = resolveFrom(here, toks[1]); return }
    if (scanTargets(head(seg), toks, here)?.kind === 'grep') hit = true
  })
  return hit
}

const GREP_NOTE = [
  'jstack scan note (once per agent): this recursive grep is allowed, but the Grep tool (ripgrep) or `git grep` does the same search 2-3x faster and skips ignored files',
  '(measured on a 7.7k-file TypeScript repo, median of 3: grep -rn 1.1 s, rg 0.46 s, git grep 0.35 s; at a repo root with worktrees: grep >120 s, rg 2.5 s).',
  'Do not swap grep for rg inside the same pattern: grep\'s `\\|` alternation is a literal pipe in rg, so the search silently finds nothing. Use `rg "a|b"` or `git grep -e a -e b`.',
].join(' ')

// ---------- state + log ----------

function stateDir() {
  const d = path.join(process.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), 'jstack-guards'), 'agents')
  fs.mkdirSync(d, { recursive: true })
  return d
}

function stateFile(payload) {
  const key = `${payload.session_id ?? 'nosession'}__${payload.agent_id ?? 'main'}`.replace(/[^\w.-]/g, '-')
  return path.join(stateDir(), key + '.json')
}

function readState(payload) {
  try { return JSON.parse(fs.readFileSync(stateFile(payload), 'utf8')) } catch { return { startedAt: Date.now(), worktrees: [] } }
}

function writeState(payload, s) {
  try { fs.writeFileSync(stateFile(payload), JSON.stringify(s)) } catch {}
}

function logPath(project) {
  return project.logFile || process.env.JSTACK_GUARDS_LOG || path.join(os.homedir(), '.jstack', 'guard-log.jsonl')
}

function log(project, payload, entry) {
  try {
    const f = logPath(project)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.appendFileSync(f, JSON.stringify({
      t: new Date().toISOString(), project: project.name, session: payload.session_id, agent: payload.agent_id ?? 'main',
      agentType: payload.agent_type, cwd: payload.cwd, ...entry,
    }) + '\n')
  } catch {}
}

function followed(pending, tool, cmd, project, cwd) {
  if (pending.guard === 'heavy-lock') return /^(?:Bash|PowerShell)$/.test(tool) && !heavyCheck(cmd, project, cwd) && (project.heavyLock?.wrappers ?? DEFAULT_WRAPPERS).some(w => cmd.includes(w))
  if (SEARCH_TOOLS.has(tool)) return true
  return /\bgit\s+(?:grep|ls-files)\b/.test(cmd)
}

function linkedWorktreesIn(cmd, cwd) {
  const found = new Set()
  const top = gitTop(cwd)
  if (top?.linked) found.add(top.root)
  const re = /(?:[A-Za-z]:[\\/]|\/[a-zA-Z]\/|\/(?:home|Users|tmp|var|opt|srv)\/)[^\s"';|&)<>]*/g
  for (const m of cmd.matchAll(re)) {
    const t = gitTop(resolveFrom(cwd, m[0]))
    if (t?.linked) found.add(t.root)
  }
  for (const m of cmd.matchAll(/(?:^|[;&|]\s*)(?:cd|pushd|Set-Location)\s+("[^"]+"|'[^']+'|\S+)/g)) {
    const t = gitTop(resolveFrom(cwd, m[1]))
    if (t?.linked) found.add(t.root)
  }
  return [...found]
}

// ---------- guard 3: no shared-stack stash when the repo has several worktrees ----------

const STASH_REASON = [
  'Blocked: this repo has more than one worktree, and `git stash` is ONE stack shared by all of them. A pop or apply here can take another agent\'s changes (and they yours).',
  'Park your work in a WIP commit instead: `git commit -am "wip"`, then later `git reset --soft HEAD~1`.',
  'Or tag it and apply by SHA: `git stash push -u -m "<unique tag>"`, find its SHA with `git stash list --format="%H %s"`, then `git stash apply <sha>` (and `git stash drop` that entry). `git stash list` and `git stash show` stay allowed.',
].join('\n')

function stashVerb(seg) {
  const toks = tokens(seg)
  while (toks.length && PREFIX.test(toks[0])) toks.shift()
  if (!toks.length || toks[0].replace(/^.*[\/]/, '').replace(/\.exe$/i, '') !== 'git') return null
  let i = 1
  while (i < toks.length && toks[i].startsWith('-')) i += /^-[Cc]$/.test(toks[i]) ? 2 : 1
  if (toks[i] !== 'stash') return null
  const rest = toks.slice(i + 1)
  if (!rest.length) return 'bare'
  const sub = rest[0].startsWith('-') ? 'push' : rest[0]
  const args = rest[0].startsWith('-') ? rest : rest.slice(1)
  if (sub === 'pop') return 'pop'
  if (sub === 'push' && !args.some(a => /^(?:-m|--message)(?:=.+)?$/.test(a) || /^-m.+/.test(a))) return 'push without -m'
  if (sub === 'apply' && !args.some(a => /^[0-9a-f]{7,40}$/i.test(a))) return 'apply without a SHA'
  return null
}

function worktreeCount(cwd) {
  const r = spawnSync('git', ['-C', cwd, 'worktree', 'list', '--porcelain'], { cwd: HOOK_DIR, encoding: 'utf8', timeout: 5000, windowsHide: true })
  if (r.status !== 0 || !r.stdout) return 0
  return r.stdout.split('\n').filter(l => l.startsWith('worktree ')).length
}

function stashCheck(cmd, project, cwd) {
  if (project?.stash?.enabled === false || !/\bstash\b/.test(cmd)) return null
  try {
    let hit = null
    walkSegments(cmd, seg => { hit ??= stashVerb(seg) })
    if (!hit || worktreeCount(cwd) < 2) return null
    return { guard: 'stash', reason: STASH_REASON, suggestion: 'git commit -am "wip" ... git reset --soft HEAD~1' }
  } catch { return null }
}

// ---------- guard 4: an agent deletes only the branches it created ----------
// new-worktree.sh records `branch.<name>.jstackCreatedBy` when it creates a branch. Without that record (or with
// another agent's id, when the caller's JSTACK_AGENT / CLAUDE_AGENT_ID is known) `git branch -d/-D`, `git push
// <remote> --delete <b>` / `:<b>`, `git update-ref -d refs/heads/<b>` and `worktree-deps.mjs remove --delete-branch`
// are denied. Protected branches are denied even with a record. A git error (no git, timeout) lets the call through.

const BASE_PROTECTED = ['main', 'master', 'production', 'develop']
const WORKTREE_DEPS_HOW = 'worktree-deps.mjs remove --delete-branch'

function gitIn(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { cwd: HOOK_DIR, encoding: 'utf8', timeout: 5000, windowsHide: true })
  if (r.error || r.status === null) throw r.error ?? new Error('git timed out')
  return r
}

// The value of branch.<b>.jstackCreatedBy, or null when there is none (git config exits 1 for a missing key).
function createdByOf(repo, branch) {
  const r = gitIn(repo, ['config', '--get', `branch.${branch}.jstackCreatedBy`])
  if (r.status === 0) return r.stdout.trim() || null
  if (r.status === 1) return null
  throw new Error(`git config exited ${r.status}`)
}

function protectedBranches(project, repo, env) {
  const remoteHead = gitIn(repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  return new Set([
    ...BASE_PROTECTED,
    env.JSTACK_INTEGRATION_BRANCH || 'stage',
    remoteHead.status === 0 ? remoteHead.stdout.trim().replace(/^origin\//, '') : '',
    ...(env.JSTACK_PROTECTED_BRANCHES || '').split(','),
    ...(project.branchDelete?.protected ?? []),
  ].map(b => b.trim()).filter(Boolean))
}

const shortBranch = ref => ref.replace(/^\+/, '').replace(/^refs\/heads\//, '')

// What a git segment would delete, and the folder it runs in (`git -C <dir>`).
function gitDeletions(toks, cwd) {
  let i = 1, dir = cwd
  while (i < toks.length && toks[i].startsWith('-')) {
    if (toks[i] === '-C') { dir = resolveFrom(dir, toks[i + 1] ?? '.'); i += 2 } else i += toks[i] === '-c' ? 2 : 1
  }
  const sub = toks[i], args = toks.slice(i + 1)
  const out = []
  if (sub === 'branch') {
    const flags = args.filter(a => a.startsWith('-'))
    const short = f => /^-[a-zA-Z]+$/.test(f)
    const del = flags.some(f => f === '--delete' || (short(f) && /[dD]/.test(f)))
    const remotes = flags.some(f => f === '--remotes' || (short(f) && f.includes('r')))
    if (del && !remotes) for (const a of args) if (!a.startsWith('-')) out.push({ branch: a, how: 'git branch -d/-D', where: 'local' })
  } else if (sub === 'push') {
    const del = args.some(a => a === '--delete' || a === '-d')
    const pos = []
    for (let k = 0; k < args.length; k++) {
      if (/^(?:-o|--push-option|--repo|--receive-pack|--exec)$/.test(args[k])) { k++; continue }
      if (!args[k].startsWith('-')) pos.push(args[k])
    }
    for (const ref of pos.slice(1)) {
      if (del) out.push({ branch: shortBranch(ref), how: 'git push --delete', where: 'remote' })
      else if (/^\+?:./.test(ref)) out.push({ branch: shortBranch(ref.replace(/^\+?:/, '')), how: 'git push :<branch>', where: 'remote' })
    }
  } else if (sub === 'update-ref' && args.some(a => a === '-d' || a === '--delete')) {
    for (const a of args) if (a.startsWith('refs/heads/')) out.push({ branch: shortBranch(a), how: 'git update-ref -d', where: 'local' })
  }
  return { dir, out }
}

// `worktree-deps.mjs remove <worktree> --delete-branch`: the branch checked out in that worktree.
function worktreeDepsDeletion(toks, cwd) {
  const at = toks.findIndex(t => /(?:^|[\\/])worktree-deps\.mjs$/.test(t))
  if (at < 0 || toks[at + 1] !== 'remove' || !toks.includes('--delete-branch')) return null
  const target = toks.slice(at + 2).find(t => !t.startsWith('-'))
  if (!target) return null
  const dir = resolveFrom(cwd, target)
  if (gitTop(dir)?.root !== norm(dir)) return null
  const r = gitIn(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  const branch = r.status === 0 ? r.stdout.trim() : ''
  return branch ? { dir, out: [{ branch, how: WORKTREE_DEPS_HOW, where: 'local' }] } : null
}

function deletionRefusal(d, project, caller, env) {
  if (protectedBranches(project, d.dir, env).has(d.branch)) return `${d.branch} is a protected branch`
  const by = createdByOf(d.dir, d.branch)
  if (!by) return `no agent created ${d.branch} through jstack (git config has no branch.${d.branch}.jstackCreatedBy)`
  if (caller && by !== caller) return `${d.branch} was created by ${by}, not by you (${caller})`
  return null
}

function branchDeleteCheck(cmd, project, cwd, env = process.env) {
  if (project?.branchDelete?.enabled === false || !/\b(?:branch|push|update-ref|worktree-deps)\b/.test(cmd)) return null
  try {
    const found = []
    let here = cwd
    walkSegments(cmd, seg => {
      const toks = tokens(seg)
      while (toks.length && PREFIX.test(toks[0])) toks.shift()
      if (!toks.length) return
      const prog = toks[0].replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase()
      if (/^(?:cd|pushd|set-location|sl|chdir)$/.test(prog) && toks[1]) { here = resolveFrom(here, toks[1]); return }
      const hit = prog === 'git' ? gitDeletions(toks, here) : worktreeDepsDeletion(toks, here)
      if (hit?.out.length) found.push(...hit.out.map(d => ({ ...d, dir: hit.dir })))
    })
    const caller = env.JSTACK_AGENT || env.CLAUDE_AGENT_ID || null
    for (const d of found) {
      const why = deletionRefusal(d, project, caller, env)
      if (!why) continue
      const instead = d.how === WORKTREE_DEPS_HOW
        ? 'Run the same remove without --delete-branch: the worktree goes, the branch stays.'
        : 'Leave the branch and say in your report that it can go.'
      const reason = [
        `jstack branch guard: ${d.how} would delete ${d.where === 'remote' ? 'the remote branch' : 'branch'} ${d.branch}, and ${why}. An agent may only delete branches it created.`,
        instead,
        `If it really should go, a human deletes it from their own terminal (\`git branch -D ${d.branch}\`, \`git push origin --delete ${d.branch}\`), or turns this guard off for the project with "branchDelete": { "enabled": false } in ~/.jstack/guards.json.`,
        d.where === 'remote' ? 'Deleting the local branch drops its record, so delete the remote branch first, or both in one command.' : '',
      ].filter(Boolean).join('\n')
      return { guard: 'branch-delete', reason, suggestion: instead }
    }
    return null
  } catch { return null }
}

// ---------- entry points ----------

function pre(payload, env = process.env) {
  const project = loadProject(payload, env)
  if (!project) return null
  const tool = payload.tool_name
  const cmd = String(payload.tool_input?.command ?? '')
  const cwd = payload.cwd || process.cwd()
  const state = readState(payload)
  if (state.pending) {
    log(project, payload, { type: 'next', guard: state.pending.guard, tool, command: cmd || payload.tool_input?.pattern, followed: followed(state.pending, tool, cmd, project, cwd) })
    delete state.pending
  }
  let verdict = null
  if (tool === 'Bash' || tool === 'PowerShell') {
    if (project.cleanup?.enabled !== false) {
      const wts = linkedWorktreesIn(cmd, cwd)
      state.worktrees = [...new Set([...(state.worktrees ?? []), ...wts])].slice(-20)
    }
    verdict = branchDeleteCheck(cmd, project, cwd, env) ?? heavyCheck(cmd, project, cwd, env) ?? scanCheck(cmd, project, cwd) ?? stashCheck(cmd, project, cwd)
    if (verdict) {
      const repeats = (state.blocks ?? 0) + 1
      state.blocks = repeats
      state.pending = { guard: verdict.guard, at: Date.now() }
      log(project, payload, { type: 'block', guard: verdict.guard, tool, command: cmd, suggestion: verdict.suggestion, repeat: repeats })
    } else calls.openWindow(payload, env)
  }
  let note = null
  if (!verdict && (tool === 'Bash' || tool === 'PowerShell') && !state.grepNoted && scopedGrep(cmd, project, cwd)) {
    state.grepNoted = true
    note = GREP_NOTE
    log(project, payload, { type: 'note', guard: 'scan', tool, command: cmd })
  }
  writeState(payload, state)
  if (note) return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: note } }
  if (!verdict) return null
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: verdict.reason } }
}

function listProcesses() {
  if (WIN) {
    const ps = "$ErrorActionPreference='SilentlyContinue'; @(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ p=[int]$_.ProcessId; pp=[int]$_.ParentProcessId; n=[string]$_.Name; c=[string]$_.CommandLine; t=$(if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }) } }) | ConvertTo-Json -Compress"
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { cwd: HOOK_DIR, encoding: 'utf8', maxBuffer: 64 << 20, timeout: 20000 })
    try { return JSON.parse(r.stdout) } catch { return [] }
  }
  // UNVERIFIED on Linux/macOS: nobody has run this branch there yet.
  const r = spawnSync('ps', ['-eo', 'pid=,ppid=,etimes=,comm=,args='], { cwd: HOOK_DIR, encoding: 'utf8', maxBuffer: 64 << 20 })
  const now = Date.now()
  return (r.stdout || '').split('\n').filter(Boolean).map(l => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(l)
    return m && { p: +m[1], pp: +m[2], t: now - +m[3] * 1000, n: path.basename(m[4]), c: m[5] }
  }).filter(Boolean)
}

function killTree(pids) {
  if (!pids.length) return
  if (WIN) {
    const ps = `$ErrorActionPreference='SilentlyContinue'; foreach ($i in @(${pids.join(',')})) { Stop-Process -Id $i -Force; if (Get-Process -Id $i) { Invoke-CimMethod -Query "select * from Win32_Process where ProcessId=$i" -MethodName Terminate | Out-Null } }`
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { cwd: HOOK_DIR, timeout: 20000 })
    return
  }
  for (const p of pids) { try { process.kill(p, 'SIGKILL') } catch {} }
}

function post(payload, env = process.env) {
  const project = loadProject(payload, env)
  if (!project || !/^(?:Bash|PowerShell)$/.test(payload.tool_name ?? '')) return
  calls.closeWindow(payload, env)
}

const NO_CLEANUP = Object.freeze({ killed: [], browsers: { closed: [], kept: [] } })

// What the stopping agent left running. Ownership, not location: only processes descending from a shell this agent's
// own tool call started (jstack-calls.mjs), or orphans only its calls could have started. A parent or sibling agent
// working in the same worktree is never touched. An agent with background work still in flight is paused, not done:
// nothing is cleaned until it stops again with nothing in flight.
function cleanup(payload, env = process.env, deps = { listProcesses, killTree }) {
  const project = loadProject(payload, env)
  if (!project) return NO_CLEANUP
  const isStop = payload.hook_event_name === 'Stop'
  const wantProcs = project.cleanup?.enabled !== false && (!isStop || project.cleanup?.onStop === true)
  const wantBrowsers = !!browsers.browsersConf(project) && (!isStop || project.browsers.onStop !== false)
  const rec = calls.readRecord(payload, env)
  const f = stateFile(payload)
  const state = exists(f, 'file') ? readState(payload) : null
  if (!rec.windows?.length || (!wantProcs && !wantBrowsers)) {
    if (!isStop) calls.markStopped(payload, env)
    if (state && !isStop) { try { fs.unlinkSync(f) } catch {} }
    return NO_CLEANUP
  }
  const procs = deps.listProcesses()
  const claudePid = calls.claudePidOf(deps.selfPid ?? process.pid, procs) ?? (Number(env.CLAUDE_PID) || null)
  if (calls.hasLiveBackground(payload, rec, procs, calls.readAllRecords(env))) {
    log(project, payload, { type: 'cleanup-skip', why: 'background work still in flight' })
    return { ...NO_CLEANUP, skipped: 'background' }
  }
  if (!isStop) calls.markStopped(payload, env, Date.now(), claudePid)
  const owners = calls.ownersOf(procs, calls.readAllRecords(env))
  const isMine = pid => { const o = owners.get(pid); return !!o && calls.isRecordOf(o.r, payload) }
  const browserResult = wantBrowsers
    ? browsers.onStop(project, payload, { procs, isMine, closeBrowsers: deps.closeBrowsers, log: e => log(project, payload, e) }, env)
    : NO_CLEANUP.browsers
  let killed = []
  if (wantProcs) {
    const mains = (project.roots ?? []).map(norm)
    const wts = (state?.worktrees ?? []).filter(w => !mains.includes(w))
    if (wts.length) {
      killed = pickOwned(procs, owners, payload, wts, project.cleanup?.processNames ?? DEFAULT_KILL_NAMES, deps.selfPid ?? process.pid)
      deps.killTree(killed)
      if (killed.length) {
        const byPid = new Map(procs.map(p => [p.p, p]))
        log(project, payload, { type: 'cleanup', worktrees: wts, killed: killed.map(p => ({ pid: p, name: byPid.get(p)?.n, cmd: String(byPid.get(p)?.c ?? '').slice(0, 200) })) })
      }
    }
  }
  if (state && !isStop) { try { fs.unlinkSync(f) } catch {} }
  return { killed, browsers: browserResult }
}

const HELPERS = /ram-clean\.ps1|run-capped\.ps1|heavy-lock|mem-map\.ps1|node-memory-watch/i

// Processes this agent owns, with a configured name, whose command line names one of its worktrees; then their
// descendants (owned too). Orphans (launcher gone) qualify only when no other agent's call could have started them,
// and never the lock/RAM helpers. Never the hook's own ancestors or the Claude CLI. Deepest first.
function pickOwned(procs, owners, payload, worktrees, names, selfPid) {
  const byPid = new Map(procs.map(p => [p.p, p]))
  const ancestors = new Set([selfPid])
  for (let p = byPid.get(selfPid), i = 0; p && i < 50; p = byPid.get(p.pp), i++) ancestors.add(p.p)
  const wanted = new Set(names.map(n => n.toLowerCase().replace(/\.exe$/, '')))
  const mine = pid => { const o = owners.get(pid); return o && calls.isRecordOf(o.r, payload) ? o : null }
  const hits = new Set()
  for (const p of procs) {
    const name = String(p.n || '').toLowerCase().replace(/\.exe$/, '')
    if (!wanted.has(name) || ancestors.has(p.p) || /^claude/.test(name)) continue
    const o = mine(p.p)
    if (!o) continue
    const c = normCmd(p.c || '')
    if (o.via === 'orphan' && HELPERS.test(c)) continue
    if (worktrees.some(w => new RegExp(`${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[/"'\\s]|$)`, WIN ? 'i' : '').test(c))) hits.add(p.p)
  }
  const children = new Map()
  for (const p of procs) { if (!children.has(p.pp)) children.set(p.pp, []); children.get(p.pp).push(p.p) }
  const order = []
  const visit = (pid, d) => {
    if (ancestors.has(pid) || order.some(o => o.pid === pid)) return
    if (d > 0 && !mine(pid)) return
    order.push({ pid, d })
    for (const c of children.get(pid) ?? []) visit(c, d + 1)
  }
  for (const h of hits) visit(h, 0)
  return order.sort((a, b) => b.d - a.d).map(o => o.pid)
}

// ---------- CLI: keep-browser, browser-watch ----------

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')) } catch { return null }
}

function globalLog(cfg, entry) {
  try {
    const f = cfg?.log || process.env.JSTACK_GUARDS_LOG || path.join(os.homedir(), '.jstack', 'guard-log.jsonl')
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.appendFileSync(f, JSON.stringify({ t: new Date().toISOString(), project: 'jstack-browsers', agent: 'watch', ...entry }) + '\n')
  } catch {}
}

function allProfiles(cfg) { return (cfg?.projects ?? []).flatMap(p => p.browsers?.profiles ?? []) }

function keepBrowser(args) {
  const ri = args.indexOf('--reason')
  const reason = ri >= 0 ? args[ri + 1] : undefined
  const pids = args.filter((a, i) => /^\d+$/.test(a) && (ri < 0 || i !== ri + 1)).map(Number)
  const cfg = loadConfig()
  let targets = pids
  if (!targets.length) {
    const procs = listProcesses()
    const mine = calls.claudePidOf(process.pid, procs) ?? Number(process.env.CLAUDE_PID || 0)
    targets = browsers.findBrowsers(procs, allProfiles(cfg)).filter(b => mine && b.claudePid === mine).map(b => b.pid)
  }
  if (args.includes('--off')) {
    browsers.dropKeep(targets)
    console.log(`keep marker removed: ${targets.join(' ') || 'none'}`)
    return
  }
  if (!targets.length) { console.log('No automation browser found in this session. Pass the browser or launcher pid.'); return }
  browsers.writeKeep(targets, reason)
  for (const pid of targets) globalLog(cfg, { type: 'browser-keep', pid, reason })
  console.log(`kept open for ${Math.round(browsers.KEEP_MS / 60000)} min: ${targets.join(' ')} (markers in ${path.join(calls.jstackHome(), 'keep-browser')})`)
}

function installWatcher(args) {
  if (!WIN) { console.log('--install is Windows-only (Startup folder). Elsewhere run `node jstack-guards.mjs browser-watch` from your login items.'); return }
  const self = fileURLToPath(import.meta.url)
  const vbs = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'JstackBrowserWatch.vbs')
  const cmd = [`"${process.execPath}"`, `"${self}"`, 'browser-watch', ...args.filter(a => a !== '--install')].join(' ')
  fs.writeFileSync(vbs, `' Starts the jstack browser watcher hidden at logon. Single instance.\r\nCreateObject("WScript.Shell").Run "${cmd.replace(/"/g, '""')}", 0, False\r\n`)
  spawnSync('wscript.exe', [vbs], { cwd: HOOK_DIR, stdio: 'ignore' })
  console.log(`watcher launcher: ${vbs} (started now, and at every logon)`)
}

function browserWatch(args) {
  const num = (n, d) => { const i = args.indexOf(n); return i >= 0 ? Number(args[i + 1]) : d }
  if (args.includes('--install')) return installWatcher(args)
  const once = args.includes('--once')
  const home = calls.jstackHome()
  fs.mkdirSync(home, { recursive: true })
  const seenFile = path.join(home, 'browser-watch.json')
  const lockFile = path.join(home, 'browser-watch.pid')
  if (!once) {
    try {
      const other = Number(fs.readFileSync(lockFile, 'utf8'))
      if (other && other !== process.pid) { process.kill(other, 0); return }
    } catch {}
    fs.writeFileSync(lockFile, String(process.pid))
  }
  const tick = () => {
    const cfg = loadConfig()
    const conf = cfg?.browsers ?? {}
    if (conf.watch !== true && !args.includes('--force')) return { due: [], waiting: [], off: true }
    let seen = {}
    try { seen = JSON.parse(fs.readFileSync(seenFile, 'utf8')) } catch {}
    const now = Date.now()
    const res = browsers.sweep({
      procs: listProcesses(), records: calls.readAllRecords(undefined, now),
      kept: browsers.keptPids(undefined, now, (conf.keepMinutes ?? 60) * 60_000), seen, now,
      graceMs: num('--grace', (conf.graceMinutes ?? 10) * 60) * 1000, profiles: allProfiles(cfg),
    })
    if (res.due.length) {
      const how = browsers.closeBrowsers(res.due.map(b => ({ pid: b.pid, cmd: b.cmd, profile: b.profile })))
      for (const b of res.due) {
        globalLog(cfg, { type: 'browser-close', reason: `watch:${b.why}`, pid: b.pid, name: b.name, profile: b.profile, how: how.get(b.pid), agent: b.agent ?? 'watch', session: b.session })
        delete seen[`${b.pid}:${b.t}`]
      }
    }
    try { fs.writeFileSync(seenFile, JSON.stringify(seen)) } catch {}
    return res
  }
  if (once) {
    const r = tick()
    console.log(r.off ? 'browser watch is off: set "browsers": { "watch": true } at the top of guards.json (or pass --force)' : `closed ${r.due.length}, waiting out the grace ${r.waiting.length}`)
    return
  }
  const loop = () => { try { tick() } catch (e) { globalLog(loadConfig(), { type: 'browser-watch-error', error: String(e?.message ?? e) }) } }
  loop()
  setInterval(loop, num('--every', 60) * 1000)
}

async function readStdin() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

function crashLog(mode, e) {
  try {
    let cfgLog
    try { cfgLog = JSON.parse(fs.readFileSync(configPath(), 'utf8')).log } catch {}
    const f = cfgLog || process.env.JSTACK_GUARDS_LOG || path.join(os.homedir(), '.jstack', 'guard-log.jsonl')
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.appendFileSync(f, JSON.stringify({ t: new Date().toISOString(), type: 'hook-crash', mode, error: String(e?.stack ?? e).slice(0, 2000) }) + '\n')
  } catch {}
}

// One hook invocation: reads the payload from stdin, writes a decision when there is one. Never throws.
async function runHook(mode) {
  let payload
  try { payload = JSON.parse(await readStdin()) } catch { return }
  try {
    if (mode === 'pre') {
      const out = pre(payload)
      if (out) process.stdout.write(JSON.stringify(out))
    } else if (mode === 'post') post(payload)
    else if (mode === 'cleanup') cleanup(payload)
  } catch (e) { crashLog(mode, e) }
}

async function main() {
  const mode = process.argv[2]
  if (mode === 'keep-browser') return keepBrowser(process.argv.slice(3))
  if (mode === 'browser-watch') return browserWatch(process.argv.slice(3))
  await runHook(mode)
  process.exit(0)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()

export { norm, segments, tokens, head, heavyHeads, heavyCheck, scanCheck, pre, post, cleanup, listProcesses, pickOwned, runHook, crashLog, loadProject, linkedWorktreesIn, gitTop, stashCheck, branchDeleteCheck }
