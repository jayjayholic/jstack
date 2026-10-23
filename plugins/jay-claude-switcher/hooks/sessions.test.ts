import { expect, test } from 'claude-code/testing'
import type { AccountIo, IoRequest, ReadSchedule } from '../types'
import { importAccount, readAccounts, switchAccount } from './account-io'

const HOME = 'C:/home'
const NOW = Date.parse('2026-10-23T12:00:00Z')
const LATER = '2026-10-23T15:00:00Z'
const STORE = `${HOME}/.claude/logins/accounts.json`
const CRED = `${HOME}/.claude/.credentials.json`
const CLAUDE_JSON = `${HOME}/.claude.json`

type Call = { url: string; auth?: string; body?: string; agent?: string }
type Answer = (url: string, init?: IoRequest) => { status: number; text: string; retryAfter?: string }

const fresh = (): ReadSchedule => ({ readAt: new Map(), backoff: new Map() })

function usageBody(fiveHour: number) {
  return JSON.stringify({
    limits: [
      { kind: 'session', percent: fiveHour, resets_at: LATER, scope: null },
      { kind: 'weekly_all', percent: 10, resets_at: LATER, scope: null },
    ],
  })
}

function seed(): Map<string, string> {
  const files = new Map<string, string>()
  files.set(
    STORE,
    JSON.stringify({
      accounts: [
        { key: 'a@example.com#o1', email: 'a@example.com', savedAt: 's', oauthAccount: { emailAddress: 'a@example.com', organizationUuid: 'o1' }, claudeAiOauth: { accessToken: 'a-stale', refreshToken: 'a-r', expiresAt: NOW + 3_600_000 } },
        { email: 'a@example.com', savedAt: 's', oauthAccount: { emailAddress: 'a@example.com', organizationUuid: 'o2' }, claudeAiOauth: { accessToken: 'b-old', refreshToken: 'b-r1', expiresAt: NOW - 1000, scopes: ['user:inference'] } },
      ],
    }),
  )
  files.set(CRED, JSON.stringify({ mcpOAuth: { srv: { token: 'mcp' } }, claudeAiOauth: { accessToken: 'a-live', refreshToken: 'a-r2', expiresAt: NOW + 3_600_000 } }))
  files.set(CLAUDE_JSON, JSON.stringify({ numStartups: 3, oauthAccount: { emailAddress: 'a@example.com', organizationUuid: 'o1' } }))
  return files
}

const anthropic: Answer = (url, init) => {
  if (url.endsWith('/v1/oauth/token')) return { status: 200, text: JSON.stringify({ access_token: 'b-new', refresh_token: 'b-r2', expires_in: 3600 }) }
  const auth = init?.headers?.['Authorization']
  if (auth === 'Bearer a-live') return { status: 200, text: usageBody(100) }
  if (auth === 'Bearer b-new') return { status: 200, text: usageBody(20) }
  return { status: 401, text: '' }
}

function fakeIo(files: Map<string, string>, calls: Call[], answer: Answer = anthropic): AccountIo {
  return {
    home: async () => HOME,
    now: async () => NOW,
    exists: async path => files.has(path),
    read: async path => {
      const text = files.get(path)
      if (text === undefined) throw new Error('ENOENT')
      return text
    },
    write: async (path, text) => void files.set(path, text),
    rename: async (from, to) => {
      files.set(to, files.get(from)!)
      files.delete(from)
    },
    fetch: async (url, init) => {
      calls.push({ url, auth: init?.headers?.['Authorization'], body: init?.body, agent: init?.headers?.['User-Agent'] })
      const { status, text, retryAfter } = answer(url, init)
      return { status, ok: status >= 200 && status < 300, text, retryAfter }
    },
    sessionLimits: async () => [],
  }
}

test('an expired stored token is refreshed, the rotated pair is written back, and the live login is only read', async () => {
  const files = seed()
  const calls: Call[] = []

  const { accounts, active } = await readAccounts(fakeIo(files, calls), [], fresh(), 'all')

  const store = JSON.parse(files.get(STORE)!)
  expect(store.accounts[1].claudeAiOauth).toMatchObject({ accessToken: 'b-new', refreshToken: 'b-r2', expiresAt: NOW + 3_600_000, scopes: ['user:inference'] })
  expect(store.accounts[0].claudeAiOauth.accessToken).toBe('a-stale')
  expect(JSON.parse(calls.find(c => c.url.endsWith('/oauth/token'))!.body!)).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'b-r1' })
  expect(calls.every(c => c.url.startsWith('https://api.anthropic.com/') || c.url.startsWith('https://platform.claude.com/'))).toBe(true)
  expect(calls.filter(c => c.url.endsWith('/oauth/usage')).map(c => c.auth)).toEqual(['Bearer a-live', 'Bearer b-new'])
  expect([...files.keys()].some(k => k.includes('.tmp-'))).toBe(false)
  expect(active).toBe('a@example.com#o1')
  expect(accounts.map(a => [a.key, a.windows[0]?.percent, a.error])).toEqual([
    ['a@example.com#o1', 100, null],
    ['a@example.com#o2', 20, null],
  ])
})

test('a listing read asks nothing; a keyed read asks only those accounts', async () => {
  const files = seed()
  const calls: Call[] = []
  const none = await readAccounts(fakeIo(files, calls), [], fresh(), 'none')
  expect(calls).toHaveLength(0)
  expect(none.accounts.map(a => a.key)).toEqual(['a@example.com#o1', 'a@example.com#o2'])
  await readAccounts(fakeIo(files, calls), none.accounts, fresh(), ['a@example.com#o1'])
  expect(calls.map(c => c.auth)).toEqual(['Bearer a-live'])
})

test('a 429 backs off by Retry-After: no read before then, not even a manual one, and a success clears it', async () => {
  const files = seed()
  const calls: Call[] = []
  const schedule = fresh()
  const busy: Answer = url => (url.endsWith('/oauth/usage') ? { status: 429, text: '', retryAfter: '600' } : { status: 200, text: '{}' })
  const first = await readAccounts(fakeIo(files, calls, busy), [], schedule, ['a@example.com#o1'])
  expect(first.accounts[0]!.error).toContain('429')
  expect(schedule.backoff.get('a@example.com#o1')?.until).toBe(NOW + 600_000)
  const before = calls.length
  await readAccounts(fakeIo(files, calls), first.accounts, schedule, 'all')
  expect(calls.filter(c => c.auth === 'Bearer a-live').length).toBe(before)
  schedule.backoff.set('a@example.com#o1', { until: NOW - 1, step: 300_000 })
  await readAccounts(fakeIo(files, calls), first.accounts, schedule, ['a@example.com#o1'])
  expect(schedule.backoff.has('a@example.com#o1')).toBe(false)
})

test('a failed read of a stored account with no Retry-After waits 5 minutes, then 10', async () => {
  const files = seed()
  const schedule = fresh()
  const down: Answer = () => ({ status: 503, text: '' })
  await readAccounts(fakeIo(files, [], down), [], schedule, ['a@example.com#o2'])
  expect(schedule.backoff.get('a@example.com#o2')).toEqual({ until: NOW + 300_000, step: 300_000 })
  schedule.backoff.set('a@example.com#o2', { until: NOW - 1, step: 300_000 })
  await readAccounts(fakeIo(files, [], down), [], schedule, ['a@example.com#o2'])
  expect(schedule.backoff.get('a@example.com#o2')?.step).toBe(600_000)
})

test('a refused refresh shows an error on that row, keeps the store as it was, and never shows a token', async () => {
  const files = seed()
  const before = files.get(STORE)
  const io = fakeIo(files, [], url => (url.endsWith('/oauth/token') ? { status: 400, text: '{"error":"invalid_grant"}' } : { status: 200, text: usageBody(5) }))

  const { accounts } = await readAccounts(io, [], fresh(), 'all')

  expect(files.get(STORE)).toBe(before)
  expect(accounts[1]!.error).toContain('logged out')
  expect(JSON.stringify(accounts).includes('b-r1') || JSON.stringify(accounts).includes('a-live')).toBe(false)
})

test('a switch saves the live login back, backs up .credentials.json, keeps mcpOAuth, and writes the target', async () => {
  const files = seed()

  expect((await switchAccount(fakeIo(files, []), 'a@example.com#o2')).switched).toBe(true)

  const cred = JSON.parse(files.get(CRED)!)
  expect(cred.mcpOAuth).toEqual({ srv: { token: 'mcp' } })
  expect(cred.claudeAiOauth.accessToken).toBe('b-old')
  expect(JSON.parse(files.get(CLAUDE_JSON)!)).toMatchObject({ numStartups: 3, oauthAccount: { emailAddress: 'a@example.com', organizationUuid: 'o2' } })
  const stored = JSON.parse(files.get(STORE)!).accounts
  expect(stored.length).toBe(2)
  expect(stored[0].claudeAiOauth.accessToken).toBe('a-live')
  const backup = [...files.keys()].find(k => k.startsWith(`${HOME}/.claude/logins/backups/credentials.`))
  expect(JSON.parse(files.get(backup!)!).claudeAiOauth.accessToken).toBe('a-live')
})

test('a switch decided on stale data writes nothing when the login changed elsewhere, and an unknown account throws', async () => {
  const files = seed()
  const before = new Map(files)
  expect((await switchAccount(fakeIo(files, []), 'a@example.com#o2', 'a@example.com#o9')).switched).toBe(false)
  expect(files).toEqual(before)
  await expect(switchAccount(fakeIo(files, []), 'nobody@example.com#o1')).rejects.toThrow('unknown account')
})

test('import takes the login of another config folder into the store, and refuses a folder without one', async () => {
  const files = seed()
  files.set(`${HOME}/.claude-login/.credentials.json`, JSON.stringify({ claudeAiOauth: { accessToken: 'c', refreshToken: 'c-r', expiresAt: NOW } }))
  files.set(`${HOME}/.claude-login/.claude.json`, JSON.stringify({ oauthAccount: { emailAddress: 'c@example.com', organizationUuid: 'o3' } }))

  expect(await importAccount(fakeIo(files, []))).toBe('c@example.com (?)')
  expect(JSON.parse(files.get(STORE)!).accounts.map((a: { email: string; key?: string }) => a.key ?? a.email)).toEqual(['a@example.com#o1', 'a@example.com', 'c@example.com#o3'])
  await expect(importAccount(fakeIo(files, []), '~/.nowhere')).rejects.toThrow('no login found')
})

test('with CLAUDE_CONFIG_DIR set, the login, .claude.json and the store all live there, and a first run creates the store', async () => {
  const dir = 'C:/cfg'
  const files = new Map<string, string>()
  files.set(`${dir}/.credentials.json`, JSON.stringify({ claudeAiOauth: { accessToken: 'a-live', refreshToken: 'r', expiresAt: NOW + 3_600_000 } }))
  files.set(`${dir}/.claude.json`, JSON.stringify({ oauthAccount: { emailAddress: 'a@example.com', organizationUuid: 'o1' } }))
  files.set(`${HOME}/.claude-login/.credentials.json`, JSON.stringify({ claudeAiOauth: { accessToken: 'c', refreshToken: 'c-r', expiresAt: NOW } }))
  files.set(`${HOME}/.claude-login/.claude.json`, JSON.stringify({ oauthAccount: { emailAddress: 'c@example.com', organizationUuid: 'o3' } }))
  const io = { ...fakeIo(files, []), configDir: async () => dir }

  await importAccount(io)
  expect(files.has(`${dir}/logins/accounts.json`)).toBe(true)
  expect(files.has(STORE)).toBe(false)
  const view = await readAccounts(io, [], fresh(), 'none')
  expect(view.active).toBe('a@example.com#o1')
  expect(JSON.parse(files.get(`${dir}/logins/accounts.json`)!).accounts.map((x: { key: string }) => x.key)).toEqual(['c@example.com#o3', 'a@example.com#o1'])
})

test('an empty CLAUDE_CONFIG_DIR falls back to the home layout, and a folder with only one of the two files is refused', async () => {
  const files = seed()
  files.set(`${HOME}/.half/.credentials.json`, JSON.stringify({ claudeAiOauth: { accessToken: 'c', refreshToken: 'c-r', expiresAt: NOW } }))
  const io = { ...fakeIo(files, []), configDir: async () => '' }

  await expect(importAccount(io, '~/.half')).rejects.toThrow('no login found')
  expect((await readAccounts(io, [], fresh(), 'none')).active).toBe('a@example.com#o1')
})

test('a stored token refused with 401 before its expiry is refreshed with its refresh token, rotated and saved', async () => {
  const files = seed()
  const calls: Call[] = []
  const store = JSON.parse(files.get(STORE)!)
  store.accounts[1].claudeAiOauth = { accessToken: 'b-revoked', refreshToken: 'b-r1', expiresAt: NOW + 3_600_000 }
  files.set(STORE, JSON.stringify(store))
  const answer: Answer = (url, init) => {
    if (url.endsWith('/v1/oauth/token')) return { status: 200, text: JSON.stringify({ access_token: 'b-new', refresh_token: 'b-r2', expires_in: 3600 }) }
    return init?.headers?.['Authorization'] === 'Bearer b-new' ? { status: 200, text: usageBody(7) } : { status: 401, text: '' }
  }
  const { accounts } = await readAccounts(fakeIo(files, calls, answer), [], fresh(), ['a@example.com#o2'])
  expect(accounts[1]).toMatchObject({ error: null, windows: [{ percent: 7 }, { percent: 10 }] })
  expect(JSON.parse(files.get(STORE)!).accounts[1].claudeAiOauth).toMatchObject({ accessToken: 'b-new', refreshToken: 'b-r2' })
  expect(calls.every(c => typeof c.agent === 'string' && c.agent.length > 0)).toBe(true)
})

test('a refresh blocked by a firewall or a 5xx is not a logout: the account stays a candidate and is tried later', async () => {
  const files = seed()
  const before = files.get(STORE)
  const schedule = fresh()
  const blocked: Answer = url => (url.endsWith('/v1/oauth/token') ? { status: 403, text: 'error code: 1010' } : { status: 401, text: '' })
  const { accounts } = await readAccounts(fakeIo(files, [], blocked), [], schedule, ['a@example.com#o2'])
  expect(accounts[1]!.error).toContain('trying again later')
  expect(accounts[1]!.error!.startsWith('logged out')).toBe(false)
  expect(files.get(STORE)).toBe(before)
  expect(schedule.backoff.has('a@example.com#o2')).toBe(true)
})

test('only a refused refresh (invalid_grant) marks the account logged out', async () => {
  const files = seed()
  const refused: Answer = url => (url.endsWith('/v1/oauth/token') ? { status: 400, text: '{"error":"invalid_grant"}' } : { status: 401, text: '' })
  const { accounts } = await readAccounts(fakeIo(files, [], refused), [], fresh(), ['a@example.com#o2'])
  expect(accounts[1]!.error!.startsWith('logged out')).toBe(true)
})
