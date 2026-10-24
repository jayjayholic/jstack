import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const HOME = 'C:/home'
const NOW = Date.parse('2026-10-23T12:00:00Z')
const LATER = '2026-10-23T15:00:00Z'
const STORE = `${HOME}/.claude/logins/accounts.json`
const CRED = `${HOME}/.claude/.credentials.json`
const CLAUDE_JSON = `${HOME}/.claude.json`
const USAGE = 'https://api.anthropic.com/api/oauth/usage'

type Reply = { status: number; body?: unknown; retryAfter?: string; gate?: Promise<void> }

const usage = (fiveHour: number, week: number) => ({
  limits: [
    { kind: 'session', percent: fiveHour, resets_at: LATER, scope: null },
    { kind: 'weekly_all', percent: week, resets_at: LATER, scope: null },
  ],
})

const stored = (email: string, org: string, token: string) => ({
  key: `${email}#${org}`,
  email,
  savedAt: 's',
  oauthAccount: { emailAddress: email, organizationUuid: org },
  claudeAiOauth: { accessToken: token, refreshToken: `${token}-r`, expiresAt: NOW + 3_600_000 },
})

// The files, the network and the session's own numbers beneath the plugin, all in memory.
function world(on: On, replies: Record<string, Reply>, sessionFiveHour: number) {
  const files = new Map<string, string>()
  files.set(STORE, JSON.stringify({ accounts: [stored('a@example.com', 'o1', 'a-live'), stored('b@example.com', 'o2', 'b-tok'), stored('c@example.com', 'o3', 'c-tok')] }))
  files.set(CRED, JSON.stringify({ mcpOAuth: { keep: true }, claudeAiOauth: stored('a@example.com', 'o1', 'a-live').claudeAiOauth }))
  files.set(CLAUDE_JSON, JSON.stringify({ oauthAccount: { emailAddress: 'a@example.com', organizationUuid: 'o1' } }))
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { USERPROFILE: HOME })
  // The engine hands paths over in the platform's own spelling.
  const at = (path: string) => path.replace(/\\/g, '/')
  on('fs.exists', (_$, e) => ({ value: files.has(at(e.path)) }))
  on('fs.read', (_$, e) => {
    const text = files.get(at(e.path))
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.write', (_$, e) => {
    files.set(at(e.path), e.text)
    return { value: undefined }
  })
  on('process.run', (_$, e) => {
    const [, , , from, to] = e.argv.map(at)
    if (from && to && files.has(from)) {
      files.set(to, files.get(from)!)
      files.delete(from)
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } as never }
  })
  on('http.fetch', async (_$, e) => {
    const auth = (e.init?.headers as Record<string, string> | undefined)?.['Authorization'] ?? ''
    const reply: Reply = e.url === USAGE ? (replies[auth.replace('Bearer ', '')] ?? { status: 500 }) : { status: 400, body: {} }
    if (reply.gate) await reply.gate
    if (e.url === USAGE && held.gate) await held.gate
    const headers: Record<string, string> = reply.retryAfter ? { 'retry-after': reply.retryAfter } : {}
    return { value: { status: reply.status, ok: reply.status === 200, headers, text: JSON.stringify(reply.body ?? {}) } }
  })
  let live = sessionFiveHour
  const held: { gate: Promise<void> | null } = { gate: null }
  on('session.usage', () => ({ value: { rateLimits: [{ kind: 'five_hour', percentUsed: live, resetsAt: LATER }] } as never }))
  on('session.measure', () => ({ changed: ['rateLimits'] }) as never)
  on('classic.StopFailure', () => ({}))
  on('ui.toast', () => ({ value: undefined }))
  const statuses: (string | undefined)[] = []
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('turn.complete', () => ({ text: '' }))
  // What session.start asks of the engine, so its timers (the 1 s switch check, the 5 s reads) run.
  on('session.start', (_$, e) => ({ cwd: (e as { cwd: string }).cwd }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: false } }) as never)
  on('agent.list', () => ({ value: [] }) as never)
  const activeToken = () => (JSON.parse(files.get(CRED)!) as { claudeAiOauth: { accessToken: string } }).claudeAiOauth.accessToken
  const setLive = (percent: number) => {
    live = percent
  }
  const holdReads = (gate: Promise<void> | null) => {
    held.gate = gate
  }
  return { files, clock, activeToken, statuses, setLive, holdReads }
}

const PANE = {
  plugin: 'jay-claude-switcher',
  component: 'Pane',
  requestId: 'switcher-sessions',
  surface: 'terminal',
  props: { title: 'Sessions', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const measure = (percent: number) =>
  ({ changed: ['rateLimits'], rateLimits: [{ kind: 'five_hour', percentUsed: percent, resetsAt: LATER }], context: {} }) as never

test('the moment the shown percent reaches 99 the session switches, even when another account answers the usage endpoint with a 429', async ($, on) => {
  const { clock, activeToken } = world(on, { 'b-tok': { status: 200, body: usage(2, 14) }, 'c-tok': { status: 429, retryAfter: '600' }, 'a-live': { status: 429 } }, 60)
  const ui = await $.ui.mount(PANE)
  await clock.settle()
  await $.session.measure(measure(98.4))
  await clock.settle()
  expect(activeToken()).toBe('a-live')
  await $.session.measure(measure(98.5))
  await clock.settle()
  expect(activeToken()).toBe('b-tok')
  await ui.unmount()
})

test('a limit error on the session itself switches, without any reading at 99%', async ($, on) => {
  const { clock, files, activeToken } = world(on, { 'b-tok': { status: 429 }, 'c-tok': { status: 200, body: usage(0, 96) }, 'a-live': { status: 429 } }, 40)
  const ui = await $.ui.mount(PANE)
  await clock.settle()
  await $.classic.StopFailure({ error: 'overloaded' } as never)
  await clock.settle()
  expect(activeToken()).toBe('a-live')
  await $.classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your session limit" } as never)
  await clock.settle()
  expect(activeToken()).toBe('c-tok')
  expect(JSON.parse(files.get(CRED)!).mcpOAuth).toEqual({ keep: true })
  await ui.unmount()
})

test('with no account below 99% a due switch writes nothing and says why in the tab', async ($, on) => {
  const { clock, files, activeToken } = world(on, { 'b-tok': { status: 200, body: usage(100, 20) }, 'c-tok': { status: 401 }, 'a-live': { status: 200, body: usage(99.5, 30) } }, 99.5)
  const before = files.get(CRED)
  const ui = await $.ui.mount(PANE)
  await clock.settle()
  await $.session.measure(measure(99.5))
  await clock.settle()
  expect(activeToken()).toBe('a-live')
  expect(files.get(CRED)).toBe(before)
  expect(await ui.find({ type: 'Text', text: /no account below 99%.*1 at 99% or more.*1 logged out/ })).toBeDefined()
  await ui.unmount()
})

const failed = (agentId?: string) => ({ reason: 'error', answer: '', durationMs: 1, isAborted: false, turnId: 't', ...(agentId ? { agentId } : {}) }) as never

test('a limit error names the agents that died on it, and the main conversation, in the status line', async ($, on) => {
  const { clock, statuses } = world(on, { 'b-tok': { status: 429 }, 'c-tok': { status: 200, body: usage(0, 96) }, 'a-live': { status: 429 } }, 40)
  const ui = await $.ui.mount(PANE)
  await clock.settle()
  await $.turn.complete(failed('early0001agent'))
  await clock.advance(5 * 60_000)
  await $.turn.complete(failed('writer01agent'))
  await clock.settle()
  expect(statuses).toEqual([])
  await $.classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your session limit" } as never)
  await clock.settle()
  const line = statuses.at(-1) ?? ''
  expect(line).toContain('now on c@example.com')
  expect(line).toContain('the main conversation')
  expect(line).toContain('@writer01')
  expect(line).not.toContain('@early000')
  expect(await ui.find({ type: 'Text', text: /Resume: the main conversation, @writer01/ })).toBeDefined()
  await ui.unmount()
})

function gate() {
  let open = () => {}
  const closed = new Promise<void>(resolve => {
    open = resolve
  })
  return { closed, open }
}

const traceOf = (files: Map<string, string>) => files.get(`${HOME}/.claude/logins/switch-trace.log`) ?? ''

test('a usage read in flight that answers a lagging 97% does not hide the 99% the session reported: the switch still happens', async ($, on) => {
  const slow = gate()
  const { clock, activeToken, setLive, holdReads, files } = world(on, { 'b-tok': { status: 200, body: usage(2, 14) }, 'c-tok': { status: 200, body: usage(50, 50) }, 'a-live': { status: 200, body: usage(97, 30) } }, 97)
  const ui = await $.ui.mount(PANE)
  await clock.settle()
  await ui.press({ key: 'refresh' })
  await clock.settle()
  await $.session.measure(measure(97))
  holdReads(slow.closed)
  await clock.advance(5_000)
  setLive(99)
  await $.session.measure(measure(99))
  await clock.advance(1_000)
  slow.open()
  holdReads(null)
  await clock.advance(1_000)
  expect(activeToken()).toBe('b-tok')
  const trace = traceOf(files)
  expect(trace).toMatch(/reading five_hour=99/)
  expect(trace).toMatch(/decide .*peak=99 .*due=true/)
  expect(trace).toMatch(/switch .*to=b@example.com .*switched=true/)
  expect(trace).not.toMatch(/-tok|a-live|Bearer/)
  await ui.unmount()
})

test('a 99% reading switches within a second with no hook firing (the 1 s check reads the session itself), every usage read hanging', async ($, on) => {
  const hang = gate()
  const { clock, activeToken, setLive, holdReads } = world(on, { 'b-tok': { status: 200, body: usage(2, 14) }, 'c-tok': { status: 200, body: usage(50, 50) }, 'a-live': { status: 200, body: usage(96, 30) } }, 96)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
  const ui = await $.ui.mount(PANE)
  await clock.settle()
  await ui.press({ key: 'refresh' })
  await clock.settle()
  await $.session.measure(measure(96))
  holdReads(hang.closed)
  await clock.advance(6_000)
  setLive(99)
  await clock.advance(1_000)
  expect(activeToken()).toBe('b-tok')
  hang.open()
  await ui.unmount()
})

test('a 99% the session reports while a usage read hangs switches at once, not when the read ends', async ($, on) => {
  const hang = gate()
  const { clock, activeToken, setLive, holdReads } = world(on, { 'b-tok': { status: 200, body: usage(2, 14) }, 'c-tok': { status: 200, body: usage(50, 50) }, 'a-live': { status: 200, body: usage(96, 30) } }, 96)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
  const ui = await $.ui.mount(PANE)
  await clock.settle()
  await ui.press({ key: 'refresh' })
  await clock.settle()
  await $.session.measure(measure(96))
  holdReads(hang.closed)
  await clock.advance(6_000)
  setLive(99)
  await $.session.measure(measure(99))
  await clock.advance(1_000)
  expect(activeToken()).not.toBe('a-live')
  hang.open()
  await ui.unmount()
})

test("after a switch the old account's last 99% reading is not laid over the new account", async ($, on) => {
  const { clock, activeToken, setLive } = world(on, { 'b-tok': { status: 200, body: usage(2, 14) }, 'c-tok': { status: 200, body: usage(50, 50) }, 'a-live': { status: 429 } }, 60)
  const ui = await $.ui.mount(PANE)
  await clock.settle()
  setLive(99)
  await $.session.measure(measure(99))
  await clock.advance(1_000)
  expect(activeToken()).toBe('b-tok')
  await clock.advance(120_000)
  expect(activeToken()).toBe('b-tok')
  await ui.unmount()
})
