#!/usr/bin/env node
// The headless optimizer, independent of any chat session. A scheduled task fires it every 5 minutes; most runs see
// `optimizer due` say no and exit. When one is due it takes the optimizer lock, borrows the least-used Claude account
// into its own CLAUDE_CONFIG_DIR (switch.py least-used: subscription login, no API key, ~/.claude untouched), runs
// one `claude -p` with PERF.md section 7's prompt at low effort, kills the tree at the wall-clock cap, and records the
// run: optimizer.log, actions.jsonl (optimizer-run / optimizer-headless) and notices.jsonl for what needs the human.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { storeDir, loadConfig } from './store.mjs'
import { optimizerDue, optState, startOptimizer, finishOptimizer, releaseOptimizer } from './ops.mjs'

const DIR = storeDir()

const OPTIMIZER_DEFAULTS = {
  enabled: true, everyMin: 30, capMin: 25, failBackoffMin: 30, minFreeMb: 1500, model: 'sonnet', effort: 'low',
  claude: 'claude', python: 'python', switcher: '', accountsStore: path.join(os.homedir(), '.claude', 'logins', 'accounts.json'),
  configDir: '', repo: '',
}
const NO_KEY_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']
// Windows Claude Code may offer PowerShell instead of Bash, so both shells get the same two commands.
const TOOLS = ['Bash(node *)', 'Bash(git *)', 'PowerShell(node *)', 'PowerShell(git *)', 'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Edit', 'Write']

function optimizerConfig(cfg, dir = DIR) {
  const o = { ...OPTIMIZER_DEFAULTS, ...(cfg.optimizer ?? {}) }
  if (!o.configDir) o.configDir = path.join(dir, 'claude')
  if (!o.switcher) o.switcher = path.join(dir, 'app', 'switch.py')
  return o
}

// The subscription login only: no API key or token variable reaches the run, and the config folder is its own.
function childEnv(env, configDir, dir = DIR) {
  const out = { ...env, CLAUDE_CONFIG_DIR: configDir, JSTACK_PERF_DIR: dir }
  for (const k of NO_KEY_VARS) delete out[k]
  return out
}

// PERF.md section 7's prompt block, made runnable here: perf.mjs at its installed path written out in every command
// (a `$P` variable makes the command start with an assignment, which the node-only permission refuses), the
// launcher's lock and pending triggers instead of step 1, and the wall-clock cap.
function promptFrom(perfMd, { appDir, perfMdPath, pending = [], capMin, repo }) {
  const sec = perfMd.slice(perfMd.indexOf('## 7.'))
  const m = sec.replace(/\r\n/g, '\n').match(/```\n([\s\S]*?)```/)
  if (!m) throw new Error('PERF.md section 7 has no prompt block')
  const fwd = s => s.replace(/\\/g, '/')
  const perf = `node ${fwd(appDir)}/perf/perf.mjs`
  const body = m[1]
    .replace(/ ?P="node \{\{JSTACK_TOOLS\}\}\/perf\/perf\.mjs"\./, '')
    .replace(/^1\. .*$/m, `1. The launcher already ran \`optimizer start\` and holds the lock for this run: do not run start again. Pending triggers: ${JSON.stringify(pending.slice(-20))}`)
    .replace(/\$P\b/g, () => perf)
    .replace(/\{\{JSTACK_TOOLS\}\}/g, fwd(appDir))
    .replace(/PERF\.md sections/, `PERF.md (${fwd(perfMdPath)}) sections`)
  return [
    `Headless run, no human watching. The shell runs only commands that start with \`node\` or \`git\`: write each command out in full, no variables, no pipes, no \`cd\`. Hard cap: ${capMin} minutes of wall clock, then this run is killed, so reach step 6 well before that.${repo ? ` The jstack repo is ${fwd(repo)}.` : ''}`,
    body.trim(),
  ].join('\n\n')
}

// The final message: its first line is the run's summary, every further line a proposal for the human.
function parseFinal(text) {
  const lines = String(text ?? '').split(/\r?\n/).map(l => l.replace(/^\s*(?:[-*]|\d+\.)\s+/, '').trim()).filter(Boolean)
  return { summary: lines[0] ?? '', proposals: lines.slice(1) }
}

// Due unless a failed start is still backing off. Same rule `perf.mjs status` prints as the next due time.
function headlessDue(now, o, state = optState(), due = optimizerDue(now, { everyMin: o.everyMin })) {
  if (state.lastFailedAt && now - Date.parse(state.lastFailedAt) < o.failBackoffMin * 60000) return { due: false, reason: `last start failed ${state.lastFailedAt}: ${state.lastFailure ?? ''}` }
  return due
}

function log(msg, dir = DIR) {
  const file = path.join(dir, 'optimizer.log')
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 1048576) fs.renameSync(file, `${file}.1`)
    fs.appendFileSync(file, `${new Date().toISOString()} ${msg}\n`)
  } catch (e) { process.stderr.write(`optimizer.log: ${e.message}\n`) }
}

function appendJsonl(name, rec, dir = DIR) { fs.appendFileSync(path.join(dir, name), `${JSON.stringify(rec)}\n`) }

function sys32(exe) { return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', exe) }

function killTree(pid) {
  if (process.platform === 'win32') spawnSync(sys32('taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
  else { try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } } }
}

function runClaude(o, prompt, env) {
  return new Promise(resolve => {
    const args = ['-p', '--output-format', 'json', '--model', o.model, '--effort', o.effort, '--permission-mode', 'dontAsk', '--allowedTools', TOOLS.join(' '), '--no-session-persistence']
    const child = spawn(o.claude, args, { cwd: DIR, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
    let out = ''
    let err = ''
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid) }, o.capMin * 60000)
    child.stdout.on('data', c => { out += c })
    child.stderr.on('data', c => { err += c })
    child.stdin.on('error', () => { /* it died before reading the prompt; close reports why */ })
    child.on('error', e => { clearTimeout(timer); resolve({ code: null, out, err: `${err}${e.message}`, timedOut }) })
    child.on('close', code => { clearTimeout(timer); resolve({ code, out, err, timedOut }) })
    child.stdin.end(prompt)
  })
}

function parseResult(out) {
  try {
    const j = JSON.parse(out.trim().split(/\r?\n/).pop())
    return { text: typeof j.result === 'string' ? j.result : '', isError: !!j.is_error, costUsd: j.total_cost_usd ?? null, turns: j.num_turns ?? null, stop: j.subtype ?? null }
  } catch { return { text: '', isError: true, costUsd: null, turns: null, stop: 'unparsed output' } }
}

function failStart(reason) {
  releaseOptimizer()
  const s = optState()
  fs.writeFileSync(path.join(DIR, 'optimizer.json'), JSON.stringify({ ...s, lastFailedAt: new Date().toISOString(), lastFailure: String(reason).slice(0, 300) }, null, 1))
  log(`start failed, backing off: ${reason}`)
}

async function main() {
  const cfg = loadConfig(DIR)
  const o = optimizerConfig(cfg)
  if (!o.enabled) return
  const now = Date.now()
  const d = headlessDue(now, o)
  if (!d.due) return
  if (os.freemem() < o.minFreeMb * 1048576) { log(`due (${d.reason}) but deferred: ${Math.round(os.freemem() / 1048576)} MB free < ${o.minFreeMb} MB`); return }
  const lock = startOptimizer({ now, by: 'headless' })
  if (!lock.started) return log(`due but not started: ${lock.reason}`)
  log(`start: ${d.reason}`)
  const env = childEnv(process.env, o.configDir)
  fs.mkdirSync(o.configDir, { recursive: true })
  const acct = spawnSync(o.python, [o.switcher, 'least-used', '--from', o.accountsStore, '--min-valid-min', String(o.capMin + 20)], { env, encoding: 'utf8', windowsHide: true, timeout: 120000 })
  const picked = (acct.stdout ?? '').split(/\r?\n/).find(l => l.startsWith('picked ')) ?? ''
  if (acct.status !== 0 || !picked) return failStart(`no account: ${(acct.stdout ?? '').trim().split(/\r?\n/).pop() ?? ''} ${acct.error?.message ?? ''}`.trim())
  log(picked)
  const perfMdPath = path.join(DIR, 'app', 'PERF.md')
  let prompt
  try { prompt = promptFrom(fs.readFileSync(perfMdPath, 'utf8'), { appDir: path.join(DIR, 'app'), perfMdPath, pending: lock.pending, capMin: o.capMin, repo: o.repo }) } catch (e) { return failStart(`prompt: ${e.message}`) }
  const t0 = Date.now()
  const r = await runClaude(o, prompt, env)
  const res = parseResult(r.out)
  const minutes = Math.round((Date.now() - t0) / 6000) / 10
  const back = spawnSync(o.python, [o.switcher, 'give-back', '--to', o.accountsStore], { env, encoding: 'utf8', windowsHide: true, timeout: 60000 })
  log((back.stdout ?? '').trim() || `give-back: ${back.error?.message ?? 'no output'}`)
  const { summary, proposals } = parseFinal(res.text)
  const meta = { account: picked.replace(/^picked /, ''), model: o.model, effort: o.effort, minutes, exit: r.code, timedOut: r.timedOut, costUsd: res.costUsd, turns: res.turns }
  fs.mkdirSync(path.join(DIR, 'optimizer-runs'), { recursive: true })
  fs.writeFileSync(path.join(DIR, 'optimizer-runs', `${new Date(t0).toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify({ ...meta, stop: res.stop, isError: res.isError, result: res.text, stderr: r.err.slice(-2000) }, null, 1))
  const finishedByAgent = !optState().runningSince
  if (!finishedByAgent) {
    const why = r.timedOut ? `headless run killed at the ${o.capMin} min cap before optimizer finish` : `headless run ended without optimizer finish (exit ${r.code}${res.stop ? `, ${res.stop}` : ''})${summary ? `: ${summary}` : ''}`
    // Killed at the cap: it worked, so it counts as a run. Ended on its own without finish (denied tools, refused
    // login, gave up): nothing was looked at, so the lock goes, no proposal is recorded, and it backs off.
    if (!r.timedOut) return failStart(`${why}; ${r.err.trim().split(/\r?\n/).pop() ?? ''}`.slice(0, 300))
    finishOptimizer(why, { by: 'headless', ...meta })
  } else appendJsonl('actions.jsonl', { at: new Date().toISOString(), mode: 'act', action: 'optimizer-headless', why: summary.slice(0, 500), ...meta })
  for (const p of proposals) appendJsonl('notices.jsonl', { at: new Date().toISOString(), type: 'optimizer-proposal', text: p.slice(0, 500), account: meta.account })
  log(`end: ${minutes} min, exit ${r.code}${r.timedOut ? ' (cap)' : ''}, cost ${res.costUsd ?? '?'} USD, ${res.turns ?? '?'} turns, ${proposals.length} proposal(s). ${summary}`)
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main().catch(e => { log(`crash: ${e.stack || e.message}`); try { if (optState().runningSince) failStart(e.message) } catch { /* lock file unreadable */ } process.exitCode = 1 })

export { OPTIMIZER_DEFAULTS, optimizerConfig, childEnv, promptFrom, parseFinal, headlessDue, parseResult }
