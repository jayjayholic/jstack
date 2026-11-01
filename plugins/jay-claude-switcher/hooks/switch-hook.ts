import type { EngineInterface } from 'claude-code'

// After a switch, whatever else must follow (cloud sessions on the account just left) is another tool's job: the hook
// contract is ~/.jstack/cloud-kit.json `{ "onSwitch": ["<cmd>", ...args], "cwd": "<dir>" }`, run with
// `--from <key> --to <key> --trigger <out|freed|manual>` appended, detached. Only `out` means the old account hit its
// limit and cannot run a turn; after `freed` or `manual` its sessions still run, and moving them makes duplicates. The
// trigger is a hint: a receiver still checks a fresh usage reading before it moves anything. No config, or its script or folder gone:
// one trace line, nothing else. The switch never waits on it: the launcher below only spawns and exits.
const LAUNCH = `
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process')
const [from, to, trigger] = process.argv.slice(1)
const home = os.homedir()
const configPath = path.join(home, '.jstack', 'cloud-kit.json')
const trace = path.join(home, '.claude', 'logins', 'switch-trace.log')
const log = (m) => { try { fs.appendFileSync(trace, new Date().toISOString() + ' hook on-switch ' + m + String.fromCharCode(10)) } catch {} }
let config = null
try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')) } catch {}
const command = config && Array.isArray(config.onSwitch) ? config.onSwitch : null
if (!command || !command.length) { log('skipped: no hook in ' + configPath); process.exit(0) }
const gone = command.slice(1).find((a) => /[.](m?[jt]s|py|sh)$/.test(a) && !fs.existsSync(a)) || (config.cwd && !fs.existsSync(config.cwd) ? config.cwd : null)
if (gone) { log('skipped: kit missing at ' + gone); process.exit(0) }
fs.mkdirSync(path.join(home, '.jstack'), { recursive: true })
const out = fs.openSync(path.join(home, '.jstack', 'on-switch.log'), 'a')
const child = cp.spawn(command[0], [...command.slice(1), '--from', from, '--to', to, ...(trigger ? ['--trigger', trigger] : [])], {
  cwd: config.cwd || undefined, detached: true, stdio: ['ignore', out, out], windowsHide: true, shell: process.platform === 'win32',
})
child.unref()
log('started from=' + from.split('#')[0] + ' to=' + to.split('#')[0] + ' trigger=' + (trigger || '-') + ' pid=' + child.pid)
`

type SwitchTrigger = 'out' | 'freed' | 'manual'

const triggerOf = (reason: string): SwitchTrigger =>
  reason.startsWith('auto (out)') ? 'out' : reason.startsWith('auto (freed)') ? 'freed' : 'manual'

async function notifySwitch($: EngineInterface, from: string | null, to: string, trigger: SwitchTrigger): Promise<void> {
  if (!from || from === to) return
  try {
    await $.process.run(['node', '-e', LAUNCH, from, to, trigger], { timeoutMs: 10_000 })
  } catch {
    // The switch is done either way; the hook writes its own trace line when it runs.
  }
}

export { LAUNCH, notifySwitch, triggerOf }
