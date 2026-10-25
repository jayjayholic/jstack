#!/usr/bin/env node
// jstack guard hooks. One file, three entry points (see hooks.json):
//   pre      PreToolUse on Bash|PowerShell|Grep|Glob|LSP: heavy-lock guard, recursive-scan guard, block log
//   cleanup  SubagentStop (and Stop when opted in): kills what the agent left running in its worktrees
// Everything is a no-op unless ~/.jstack/guards.json (or $JSTACK_GUARDS_CONFIG) has a project whose roots
// contain the session's project dir or cwd. No dependencies, Node 18+.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

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

function heavyCheck(cmd, project) {
  const conf = project.heavyLock ?? {}
  if (conf.enabled === false) return null
  const wrappers = conf.wrappers ?? DEFAULT_WRAPPERS
  if (wrappers.some(w => new RegExp(`(?:^|[^\\w-])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^\\w-]|$)`).test(cmd))) return null
  const rules = [...(conf.patterns ?? DEFAULT_HEAVY), ...(conf.extraPatterns ?? [])].map(r => ({ kind: r.kind ?? 'build', re: new RegExp(r.re, 'i') }))
  let hit = null
  walkSegments(cmd, seg => {
    if (hit) return
    const h = head(seg)
    if (!h || LIGHT_FLAGS.test(' ' + h + ' ')) return
    const r = rules.find(x => x.re.test(h))
    if (r) hit = { kind: r.kind, segment: seg }
  })
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

function followed(pending, tool, cmd, project) {
  if (pending.guard === 'heavy-lock') return /^(?:Bash|PowerShell)$/.test(tool) && !heavyCheck(cmd, project) && (project.heavyLock?.wrappers ?? DEFAULT_WRAPPERS).some(w => cmd.includes(w))
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

// ---------- entry points ----------

function pre(payload, env = process.env) {
  const project = loadProject(payload, env)
  if (!project) return null
  const tool = payload.tool_name
  const cmd = String(payload.tool_input?.command ?? '')
  const cwd = payload.cwd || process.cwd()
  const state = readState(payload)
  if (state.pending) {
    log(project, payload, { type: 'next', guard: state.pending.guard, tool, command: cmd || payload.tool_input?.pattern, followed: followed(state.pending, tool, cmd, project) })
    delete state.pending
  }
  let verdict = null
  if (tool === 'Bash' || tool === 'PowerShell') {
    if (project.cleanup?.enabled !== false) {
      const wts = linkedWorktreesIn(cmd, cwd)
      state.worktrees = [...new Set([...(state.worktrees ?? []), ...wts])].slice(-20)
    }
    verdict = heavyCheck(cmd, project) ?? scanCheck(cmd, project, cwd)
    if (verdict) {
      const repeats = (state.blocks ?? 0) + 1
      state.blocks = repeats
      state.pending = { guard: verdict.guard, at: Date.now() }
      log(project, payload, { type: 'block', guard: verdict.guard, tool, command: cmd, suggestion: verdict.suggestion, repeat: repeats })
    }
  }
  writeState(payload, state)
  if (!verdict) return null
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: verdict.reason } }
}

function listProcesses() {
  if (WIN) {
    const ps = "$ErrorActionPreference='SilentlyContinue'; @(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ p=[int]$_.ProcessId; pp=[int]$_.ParentProcessId; n=[string]$_.Name; c=[string]$_.CommandLine; t=$(if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }) } }) | ConvertTo-Json -Compress"
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 20000 })
    try { return JSON.parse(r.stdout) } catch { return [] }
  }
  // UNVERIFIED on Linux/macOS: nobody has run this branch there yet.
  const r = spawnSync('ps', ['-eo', 'pid=,ppid=,etimes=,comm=,args='], { encoding: 'utf8', maxBuffer: 64 << 20 })
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
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 20000 })
    return
  }
  for (const p of pids) { try { process.kill(p, 'SIGKILL') } catch {} }
}

// Picks processes whose command line names one of the worktrees, started after the agent's first command,
// with a configured name; then adds their descendants. Never the hook's own ancestors or the Claude CLI.
function pickVictims(procs, worktrees, since, names, selfPid) {
  const byPid = new Map(procs.map(p => [p.p, p]))
  const ancestors = new Set()
  for (let p = byPid.get(selfPid), i = 0; p && i < 50; p = byPid.get(p.pp), i++) ancestors.add(p.p)
  ancestors.add(selfPid)
  const wanted = new Set(names.map(n => n.toLowerCase().replace(/\.exe$/, '')))
  const hits = new Set()
  for (const p of procs) {
    const name = String(p.n || '').toLowerCase().replace(/\.exe$/, '')
    if (!wanted.has(name) || ancestors.has(p.p) || /^claude/.test(name)) continue
    if (p.t && p.t < since - 2000) continue
    const c = normCmd(p.c || '')
    if (worktrees.some(w => new RegExp(`${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[/"'\\s]|$)`, WIN ? 'i' : '').test(c))) hits.add(p.p)
  }
  const children = new Map()
  for (const p of procs) { if (!children.has(p.pp)) children.set(p.pp, []); children.get(p.pp).push(p.p) }
  const order = []
  const visit = (pid, d) => { if (ancestors.has(pid) || order.some(o => o.pid === pid)) return; order.push({ pid, d }); for (const c of children.get(pid) ?? []) visit(c, d + 1) }
  for (const h of hits) visit(h, 0)
  return order.sort((a, b) => b.d - a.d).map(o => o.pid)
}

function cleanup(payload, env = process.env, deps = { listProcesses, killTree }) {
  const project = loadProject(payload, env)
  if (!project || project.cleanup?.enabled === false) return { killed: [] }
  if (payload.hook_event_name === 'Stop' && project.cleanup?.onStop !== true) return { killed: [] }
  const f = stateFile(payload)
  if (!exists(f, 'file')) return { killed: [] }
  const state = readState(payload)
  const mains = (project.roots ?? []).map(norm)
  const wts = (state.worktrees ?? []).filter(w => !mains.includes(w))
  let killed = []
  if (wts.length) {
    const procs = deps.listProcesses()
    killed = pickVictims(procs, wts, state.startedAt ?? Date.now(), project.cleanup?.processNames ?? DEFAULT_KILL_NAMES, process.pid)
    deps.killTree(killed)
    if (killed.length) {
      const byPid = new Map(procs.map(p => [p.p, p]))
      log(project, payload, { type: 'cleanup', worktrees: wts, killed: killed.map(p => ({ pid: p, name: byPid.get(p)?.n, cmd: String(byPid.get(p)?.c ?? '').slice(0, 200) })) })
    }
  }
  try { fs.unlinkSync(f) } catch {}
  return { killed }
}

async function readStdin() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

async function main() {
  const mode = process.argv[2]
  let payload
  try { payload = JSON.parse(await readStdin()) } catch { process.exit(0) }
  try {
    if (mode === 'pre') {
      const out = pre(payload)
      if (out) process.stdout.write(JSON.stringify(out))
    } else if (mode === 'cleanup') {
      cleanup(payload)
    }
  } catch (e) {
    process.stderr.write(`jstack guards: ${e?.message ?? e}\n`)
  }
  process.exit(0)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()

export { norm, segments, tokens, head, heavyCheck, scanCheck, pre, cleanup, pickVictims, loadProject, linkedWorktreesIn, gitTop }
