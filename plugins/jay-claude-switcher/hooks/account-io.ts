import type { EngineInterface } from 'claude-code'
import type { AccountIo, AccountStore, AccountView, CurrentLogin, OAuthTokens, ReadSchedule, ReadWhich, SessionWindow } from '../types'
import { planMultiple } from './balance'
import { applyRefresh, backoffAfter, keyOf, needsRefresh, orgOf, parseUsage, savedCurrent, storedKey, tierOf, windowsFromRateLimits, withTokens } from './accounts'

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const OAUTH_BETA = 'oauth-2025-04-20'
// The token endpoint's firewall refuses some runtimes' default agent (Cloudflare 1010): name ourselves.
const USER_AGENT = 'jay-claude-switcher/0.8'
const RENAME = 'require("fs").renameSync(process.argv[1], process.argv[2])'

type Paths = { home: string; credentials: string; claudeJson: string; store: string; backups: string }

// Claude Code's own layout: with CLAUDE_CONFIG_DIR set, both files live in that folder; without it,
// .credentials.json is in ~/.claude and .claude.json in the home folder.
function pathsOf(home: string, configDir = ''): Paths {
  const config = configDir || `${home}/.claude`
  return {
    home,
    credentials: `${config}/.credentials.json`,
    claudeJson: configDir ? `${configDir}/.claude.json` : `${home}/.claude.json`,
    store: `${config}/logins/accounts.json`,
    backups: `${config}/logins/backups`,
  }
}

const isWindowsPath = (path: string) => /^[A-Za-z]:/.test(path)

// The variables first; then the shell's own view of the profile folder, then Node's.
async function homeOf($: EngineInterface): Promise<string> {
  const fromEnv = (await $.env.get('USERPROFILE').catch(() => undefined)) || (await $.env.get('HOME').catch(() => undefined))
  if (fromEnv) return fromEnv
  const cmd = await $.process.run(['cmd', '/c', 'echo %USERPROFILE%'], { timeoutMs: 10_000 }).catch(() => null)
  const fromCmd = cmd?.exitCode === 0 ? cmd.stdout.trim() : ''
  if (fromCmd && !fromCmd.includes('%')) return fromCmd
  const node = await $.process.run(['node', '-p', 'require("os").homedir()'], { timeoutMs: 10_000 }).catch(() => null)
  return node?.exitCode === 0 ? node.stdout.trim() : ''
}

// The engine's nouns behind one small seam, so the account logic runs the same against a fake in the tests.
function ioOf($: EngineInterface): AccountIo {
  return {
    home: async () => (await homeOf($)).replace(/\\/g, '/'),
    configDir: async () => ((await $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined)) ?? '').replace(/\\/g, '/').replace(/\/+$/, ''),
    now: () => $.clock.now(),
    exists: path => $.fs.exists(path),
    read: path => $.fs.read(path),
    // Every file written here holds tokens: owner-only on macOS/Linux (a Windows profile folder already is).
    write: async (path, text) => {
      await $.fs.write(path, text)
      if (!isWindowsPath(path)) await $.process.run(['chmod', '600', path], { timeoutMs: 10_000 }).catch(() => undefined)
    },
    rename: async (from, to) => {
      const moved = await $.process.run(['node', '-e', RENAME, from, to], { timeoutMs: 15_000 }).catch(() => null)
      if (moved?.exitCode === 0) return
      const fallback = await $.process.run(['cmd', '/c', 'move', '/y', from.replace(/\//g, '\\'), to.replace(/\//g, '\\')], { timeoutMs: 15_000 })
      if (fallback.exitCode !== 0) throw new Error(`could not replace ${to}`)
    },
    fetch: async (url, init) => {
      const r = await $.http.fetch(url, init)
      return { status: r.status, ok: r.ok, text: r.text, retryAfter: r.headers['retry-after'] }
    },
    sessionLimits: async () => (await $.session.usage()).rateLimits as SessionWindow[],
  }
}

async function paths(io: AccountIo): Promise<Paths> {
  const home = await io.home()
  if (!home) throw new Error('no home directory')
  return pathsOf(home, (await io.configDir?.()) ?? '')
}

async function readJson<T>(io: AccountIo, path: string, fallback: T): Promise<T> {
  if (!(await io.exists(path))) return fallback
  const text = await io.read(path)
  try {
    return JSON.parse(text.replace(/^\uFEFF/, '')) as T
  } catch {
    throw new Error(`${path} is not valid JSON`)
  }
}

// Temp file, then a rename: a reader sees the old file or the new, never half of one.
async function writeAtomic(io: AccountIo, path: string, data: unknown): Promise<void> {
  const tmp = `${path}.tmp-${await io.now()}`
  await io.write(tmp, `${JSON.stringify(data, null, 2)}\n`)
  await io.rename(tmp, path)
}

async function loginIn(io: AccountIo, credentialsPath: string, claudeJsonPath: string): Promise<CurrentLogin> {
  const [cred, cj] = await Promise.all([
    readJson<{ claudeAiOauth?: OAuthTokens }>(io, credentialsPath, {}),
    readJson<{ oauthAccount?: Record<string, unknown> }>(io, claudeJsonPath, {}),
  ])
  const oauthAccount = cj.oauthAccount ?? {}
  const email = typeof oauthAccount['emailAddress'] === 'string' ? (oauthAccount['emailAddress'] as string) : null
  return { key: email ? keyOf(email, oauthAccount) : null, email, oauthAccount, oauth: cred.claudeAiOauth?.accessToken ? cred.claudeAiOauth : null }
}

async function readStore(io: AccountIo, p: Paths): Promise<AccountStore> {
  // First run: no store yet. The live login is added to it on the first read.
  if (!(await io.exists(p.store))) return { accounts: [] }
  const store = await readJson<AccountStore>(io, p.store, { accounts: [] })
  return Array.isArray(store.accounts) ? store : { ...store, accounts: [] }
}

function stampOf(now: number): string {
  return new Date(now).toISOString().slice(0, 19)
}

async function refreshTokens(io: AccountIo, oauth: OAuthTokens, now: number): Promise<OAuthTokens> {
  const body = { grant_type: 'refresh_token', refresh_token: oauth.refreshToken, client_id: CLIENT_ID, scope: (oauth.scopes ?? []).join(' ') }
  const r = await io.fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT }, body: JSON.stringify(body) })
  // Only a refused refresh means the login is gone; anything else (a firewall, a 5xx, a 429) is tried again later.
  if (!r.ok) throw new ReadError(r.status === 400 || r.status === 401 ? 'logged out: its refresh token was refused; sign in again and import it' : `token refresh HTTP ${r.status}, trying again later`, r.retryAfter)
  return applyRefresh(oauth, JSON.parse(r.text), now)
}

// Rotated tokens go back to the store at once (a refresh spends the old refresh token), read fresh so a change
// another writer made to other rows survives.
async function storeTokens(io: AccountIo, p: Paths, key: string, oauth: OAuthTokens): Promise<void> {
  await writeAtomic(io, p.store, withTokens(await readStore(io, p), key, oauth))
}

async function fetchUsage(io: AccountIo, token: string) {
  const r = await io.fetch(USAGE_URL, {
    headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': OAUTH_BETA, 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
  })
  return { status: r.status, retryAfter: r.retryAfter, windows: r.ok ? parseUsage(JSON.parse(r.text)) : [], fromEndpoint: true }
}

class ReadError extends Error {
  constructor(
    message: string,
    readonly retryAfter?: string,
  ) {
    super(message)
  }
}

async function readStored(io: AccountIo, p: Paths, key: string, oauth: OAuthTokens, now: number) {
  let tokens = oauth
  if (needsRefresh(tokens, now)) {
    tokens = await refreshTokens(io, tokens, now)
    await storeTokens(io, p, key, tokens)
  }
  let usage = await fetchUsage(io, tokens.accessToken)
  if (usage.status === 401) {
    tokens = await refreshTokens(io, tokens, now)
    await storeTokens(io, p, key, tokens)
    usage = await fetchUsage(io, tokens.accessToken)
  }
  return usage
}

// The live login belongs to Claude Code, which refreshes and rotates it: read here, never refreshed. A 429 is
// reported (so it backs off); any other failure falls back to the session's own headers.
async function readActive(io: AccountIo, login: CurrentLogin, now: number) {
  if (login.oauth && !needsRefresh(login.oauth, now)) {
    const usage = await fetchUsage(io, login.oauth.accessToken)
    if (usage.status === 200 || usage.status === 429) return usage
  }
  return { status: 200, retryAfter: undefined, windows: windowsFromRateLimits(await io.sessionLimits()), fromEndpoint: false }
}

function describeStatus(status: number): string {
  if (status === 429) return 'usage API busy (429), waiting before the next read'
  if (status === 401 || status === 403) return `usage refused (HTTP ${status}) after a token refresh, trying again later`
  return `usage HTTP ${status}`
}

// Lists every stored account, asking the usage endpoint only for `which` ('none': no network at all). An account
// backing off after a failure is never asked before its time, not even by a manual refresh.
async function readAccounts(
  io: AccountIo,
  previous: readonly AccountView[],
  schedule: ReadSchedule,
  which: ReadWhich,
): Promise<{ accounts: AccountView[]; active: string | null }> {
  const p = await paths(io)
  const [store, login] = await Promise.all([readStore(io, p), loginIn(io, p.credentials, p.claudeJson)])
  let accounts = store.accounts
  if (login.key && !accounts.some(a => storedKey(a) === login.key)) {
    accounts = savedCurrent(store, login, stampOf(await io.now())).accounts
    await writeAtomic(io, p.store, { ...store, accounts })
  }
  const views: AccountView[] = []
  for (const a of accounts) {
    const now = await io.now()
    const key = storedKey(a)
    const old = previous.find(x => x.key === key)
    const isActive = key === login.key
    const tier = tierOf(isActive && login.oauth ? login.oauth : a.claudeAiOauth)
    const org = orgOf(isActive ? login.oauthAccount : a.oauthAccount)
    const multiple = planMultiple((isActive && login.oauth ? login.oauth : a.claudeAiOauth)?.rateLimitTier)
    const kept = { key, email: a.email, org, tier, multiple, hasWeekly: old?.hasWeekly ?? null, windows: old?.windows ?? [], fetchedAt: old?.fetchedAt ?? null }
    const wanted = which === 'all' || (which !== 'none' && which.includes(key))
    const waiting = now < (schedule.backoff.get(key)?.until ?? 0)
    if (!wanted || waiting) {
      const offline = isActive && !kept.windows.length ? windowsFromRateLimits(await io.sessionLimits()) : kept.windows
      views.push(old ? { ...old, tier, org, multiple, windows: offline } : { ...kept, windows: offline, error: null })
      continue
    }
    schedule.readAt.set(key, now)
    try {
      const usage = isActive ? await readActive(io, login, now) : await readStored(io, p, key, a.claudeAiOauth, now)
      if (usage.status === 200) {
        schedule.backoff.delete(key)
        // Only a usage answer says whether a weekly limit applies: the session's own headers never do.
        const hasWeekly = usage.fromEndpoint ? usage.windows.some(w => w.label === 'week') : kept.hasWeekly
        views.push({ ...kept, hasWeekly, windows: usage.windows, fetchedAt: now, error: null })
      } else {
        schedule.backoff.set(key, backoffAfter(schedule.backoff.get(key), usage.retryAfter, now))
        views.push({ ...kept, error: describeStatus(usage.status) })
      }
    } catch (err) {
      schedule.backoff.set(key, backoffAfter(schedule.backoff.get(key), err instanceof ReadError ? err.retryAfter : undefined, now))
      views.push({ ...kept, error: (err instanceof Error ? err.message : 'failed').slice(0, 80) })
    }
  }
  return { accounts: views, active: login.key }
}

// switch.py's `use`: the live login saved back first, a backup of .credentials.json, then the chosen account written
// into .credentials.json (`claudeAiOauth` only; `mcpOAuth` and every other key kept) and ~/.claude.json (`oauthAccount`).
// Accounts by key; with `expectFrom`, nothing is written unless the live login is still that account.
async function switchAccount(io: AccountIo, key: string, expectFrom?: string | null): Promise<{ from: string | null; switched: boolean }> {
  const p = await paths(io)
  const login = await loginIn(io, p.credentials, p.claudeJson)
  if (expectFrom !== undefined && login.key !== expectFrom) return { from: login.key, switched: false }
  const now = await io.now()
  const store = savedCurrent(await readStore(io, p), login, stampOf(now))
  const entry = store.accounts.find(a => storedKey(a) === key)
  if (!entry) throw new Error(`unknown account ${key.split('#')[0]}`)
  const credentialsText = (await io.exists(p.credentials)) ? await io.read(p.credentials) : '{}'
  await io.write(`${p.backups}/credentials.${new Date(now).toISOString().replace(/[:.]/g, '-')}.json`, credentialsText)
  // The credentials first: that write is what moves the session; the live login is already saved in `store` above.
  await writeAtomic(io, p.credentials, { ...(JSON.parse(credentialsText) as Record<string, unknown>), claudeAiOauth: entry.claudeAiOauth })
  await writeAtomic(io, p.store, store)
  const cj = await readJson<Record<string, unknown>>(io, p.claudeJson, {})
  await writeAtomic(io, p.claudeJson, { ...cj, oauthAccount: entry.oauthAccount })
  return { from: login.key, switched: true }
}

// switch.py's `import`: the login of another config folder (CLAUDE_CONFIG_DIR), added to or updated in the store.
async function importAccount(io: AccountIo, folder = '~/.claude-login'): Promise<string> {
  const p = await paths(io)
  const dir = folder.replace(/^~(?=$|[\\/])/, p.home).replace(/\\/g, '/')
  const login = await loginIn(io, `${dir}/.credentials.json`, `${dir}/.claude.json`)
  if (!login.email || !login.oauth) throw new Error(`no login found in ${folder}`)
  await writeAtomic(io, p.store, savedCurrent(await readStore(io, p), login, stampOf(await io.now())))
  return `${login.email} (${tierOf(login.oauth)})`
}

// The switcher's trace, next to the store: timestamps, emails, percents and decisions, never a token.
async function writeTrace(io: AccountIo, text: string): Promise<void> {
  const p = await paths(io)
  await io.write(p.store.replace(/accounts\.json$/, 'switch-trace.log'), text)
}

// The owner's override of the balancer's order, `priority.json` next to the store: `{ "order": ["email" or
// "email#organizationUuid", ...] }`, best first. Missing or unreadable: no override.
async function readPriority(io: AccountIo): Promise<string[]> {
  const p = await paths(io)
  const file = p.store.replace(/accounts\.json$/, 'priority.json')
  const json = await readJson<{ order?: unknown }>(io, file, {}).catch(() => ({ order: [] }))
  return Array.isArray(json.order) ? json.order.filter((x): x is string => typeof x === 'string') : []
}

export { importAccount, ioOf, readAccounts, readPriority, switchAccount, writeTrace }
