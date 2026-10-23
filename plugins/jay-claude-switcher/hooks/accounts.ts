import type { AccountStore, AccountView, Backoff, CurrentLogin, OAuthTokens, StoredAccount, UsageWindow } from '../types'

const SWITCH_AT = 99.9
const REFRESH_MARGIN_MS = 5 * 60_000
const WATCH_AT = 98
const ACTIVE_READ_MS = 60_000
const CANDIDATE_READ_MS = 5 * 60_000
const BACKOFF_FIRST_MS = 5 * 60_000
const BACKOFF_MAX_MS = 30 * 60_000

type RawLimit = {
  kind?: unknown
  percent?: unknown
  resets_at?: unknown
  scope?: { model?: { display_name?: unknown } | null; surface?: { display_name?: unknown } | null } | null
}
type RawWindow = { utilization?: unknown; resets_at?: unknown } | null | undefined

const LEGACY_WINDOWS: { key: string; label: string; binding: boolean }[] = [
  { key: 'five_hour', label: '5h', binding: true },
  { key: 'seven_day', label: 'week', binding: true },
  { key: 'seven_day_opus', label: 'wk Opus', binding: false },
  { key: 'seven_day_sonnet', label: 'wk Sonnet', binding: false },
]

const RATE_LIMIT_LABELS: Record<string, { label: string; binding: boolean }> = {
  five_hour: { label: '5h', binding: true },
  seven_day: { label: 'week', binding: true },
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

// The `limits` list is what /usage draws today; the per-window fields are the older shape, kept as a fallback.
function parseUsage(body: unknown): UsageWindow[] {
  const json = (body ?? {}) as Record<string, unknown>
  const limits = Array.isArray(json['limits']) ? (json['limits'] as RawLimit[]) : []
  const fromLimits = limits
    .filter(l => typeof l.percent === 'number' && typeof l.kind === 'string')
    .map(l => {
      const kind = l.kind as string
      const scoped = text(l.scope?.model?.display_name) ?? text(l.scope?.surface?.display_name)
      const label = kind === 'session' ? '5h' : kind === 'weekly_all' ? 'week' : `wk ${scoped ?? kind}`
      return {
        key: scoped ? `${kind}:${scoped}` : kind,
        label,
        percent: l.percent as number,
        resetsAt: text(l.resets_at),
        binding: kind === 'session' || kind === 'weekly_all',
      }
    })
  if (fromLimits.length) return fromLimits.filter(w => w.binding)
  return LEGACY_WINDOWS.flatMap(w => {
    const raw = json[w.key] as RawWindow
    if (!raw || typeof raw.utilization !== 'number') return []
    return [{ key: w.key, label: w.label, percent: raw.utilization, resetsAt: text(raw.resets_at), binding: w.binding }]
  }).filter(w => w.binding)
}

// The session's own rate-limit headers, for the active account when its token cannot be used directly.
function windowsFromRateLimits(limits: readonly { kind: string; percentUsed: number; resetsAt?: string }[]): UsageWindow[] {
  return limits
    .filter(l => RATE_LIMIT_LABELS[l.kind])
    .map(l => ({ key: l.kind, ...RATE_LIMIT_LABELS[l.kind]!, percent: l.percentUsed, resetsAt: l.resetsAt ?? null }))
}

// A window whose reset time has passed reads as empty, even from a cached reading.
function effectivePercent(w: UsageWindow, now: number): number {
  if (w.resetsAt && Date.parse(w.resetsAt) <= now) return 0
  return w.percent
}

function peakOf(a: AccountView, now: number): number | null {
  const binding = a.windows.filter(w => w.binding)
  if (!binding.length) return null
  return Math.max(...binding.map(w => effectivePercent(w, now)))
}

function fiveHourOf(a: AccountView, now: number): number {
  const w = a.windows.find(x => x.binding && x.label === '5h')
  return w ? effectivePercent(w, now) : 0
}

function leastUsed(accounts: readonly AccountView[], excludeKey: string | null, now: number, threshold = SWITCH_AT): AccountView | null {
  const candidates = accounts
    .filter(a => a.key !== excludeKey && a.fetchedAt !== null && !a.error)
    .map(a => ({ a, peak: peakOf(a, now) }))
    .filter((c): c is { a: AccountView; peak: number } => c.peak !== null && c.peak < threshold)
    .sort((x, y) => x.peak - y.peak || fiveHourOf(x.a, now) - fiveHourOf(y.a, now))
  return candidates[0]?.a ?? null
}

function switchTarget(
  accounts: readonly AccountView[],
  activeKey: string | null,
  now: number,
  threshold = SWITCH_AT,
): { to: string; label: string; reason: string } | null {
  const current = accounts.find(a => a.key === activeKey)
  if (!current) return null
  const peak = peakOf(current, now)
  if (peak === null || peak < threshold) return null
  const target = leastUsed(accounts, activeKey, now, threshold)
  if (!target) return null
  const hot = current.windows.filter(w => w.binding && effectivePercent(w, now) >= threshold).map(w => w.label)
  return { to: target.key, label: labelOf(target), reason: `${labelOf(current)} at ${peak}% (${hot.join(', ')})` }
}

// The usage endpoint is only asked once the current account nears its limit (98%, from the session's own headers).
function isWatched(a: AccountView | undefined, now: number): boolean {
  const peak = a ? peakOf(a, now) : null
  return peak !== null && peak >= WATCH_AT
}

// Retry-After is seconds or an HTTP date; anything else is no hint.
function retryAfterMs(value: string | undefined, now: number): number | null {
  if (!value) return null
  if (/^\s*-?\d+(\.\d+)?\s*$/.test(value)) {
    const seconds = Number(value)
    return seconds >= 0 ? seconds * 1000 : null
  }
  const at = Date.parse(value)
  return Number.isNaN(at) ? null : Math.max(0, at - now)
}

// A failed read waits: as long as Retry-After says, else 5 minutes, doubling per failure up to 30.
function backoffAfter(previous: Backoff | undefined, retryAfter: string | undefined, now: number): Backoff {
  const step = previous ? Math.min(previous.step * 2, BACKOFF_MAX_MS) : BACKOFF_FIRST_MS
  return { until: now + (retryAfterMs(retryAfter, now) ?? step), step }
}

// The session's own rate-limit headers, fresh on every request, laid over the current account's last reading.
function withSessionLimits(windows: readonly UsageWindow[], limits: readonly { kind: string; percentUsed: number; resetsAt?: string }[]): UsageWindow[] {
  const live = windowsFromRateLimits(limits)
  if (!live.length) return [...windows]
  const merged = windows.map(w => live.find(l => l.label === w.label) ?? w)
  return [...merged, ...live.filter(l => !windows.some(w => w.label === l.label))]
}

function resetAt(w: UsageWindow | undefined, now: number): number | null {
  if (!w?.resetsAt) return null
  const at = Date.parse(w.resetsAt)
  return Number.isNaN(at) || at <= now ? null : at
}

// Nearest availability first: an account full for the week waits for its weekly reset; any other one is placed by its
// 5h reset (none pending: first), its weekly reset breaking ties.
function byNearestReset(accounts: readonly AccountView[], now: number, threshold = SWITCH_AT): AccountView[] {
  const rank = (a: AccountView): [number, number] => {
    const week = a.windows.find(w => w.binding && w.label === 'week')
    const fiveHour = a.windows.find(w => w.binding && w.label === '5h')
    const weekReset = resetAt(week, now)
    const weekFull = week !== undefined && effectivePercent(week, now) >= threshold
    const first = weekFull ? (weekReset ?? Number.MAX_SAFE_INTEGER) : (resetAt(fiveHour, now) ?? 0)
    return [first, weekReset ?? Number.MAX_SAFE_INTEGER]
  }
  return accounts
    .map((a, i) => ({ a, i, r: rank(a) }))
    .sort((x, y) => x.r[0] - y.r[0] || x.r[1] - y.r[1] || x.i - y.i)
    .map(x => x.a)
}

function needsRefresh(oauth: OAuthTokens, now: number): boolean {
  return !oauth.accessToken || !oauth.expiresAt || oauth.expiresAt - now < REFRESH_MARGIN_MS
}

type TokenResponse = { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; refresh_token_expires_in?: unknown; scope?: unknown }

// The token endpoint rotates the refresh token: the new pair replaces the old one whole.
function applyRefresh(oauth: OAuthTokens, response: TokenResponse, now: number): OAuthTokens {
  if (typeof response.access_token !== 'string' || typeof response.expires_in !== 'number') throw new Error('malformed token response')
  const next: OAuthTokens = {
    ...oauth,
    accessToken: response.access_token,
    refreshToken: typeof response.refresh_token === 'string' ? response.refresh_token : oauth.refreshToken,
    expiresAt: now + response.expires_in * 1000,
  }
  if (typeof response.refresh_token_expires_in === 'number') next.refreshTokenExpiresAt = now + response.refresh_token_expires_in * 1000
  if (typeof response.scope === 'string' && response.scope.trim()) next.scopes = response.scope.trim().split(/\s+/)
  return next
}

function withTokens(store: AccountStore, key: string, oauth: OAuthTokens): AccountStore {
  return { ...store, accounts: store.accounts.map(a => (storedKey(a) === key ? { ...a, claudeAiOauth: oauth } : a)) }
}

// switch.py's `save`: the live login replaces its stored copy (kept in place, appended when new).
function savedCurrent(store: AccountStore, login: CurrentLogin, savedAt: string): AccountStore {
  if (!login.email || !login.key || !login.oauth) return store
  const entry: StoredAccount = { key: login.key, email: login.email, savedAt, oauthAccount: login.oauthAccount, claudeAiOauth: login.oauth }
  const exists = store.accounts.some(a => storedKey(a) === login.key)
  return {
    ...store,
    accounts: exists ? store.accounts.map(a => (storedKey(a) === login.key ? entry : a)) : [...store.accounts, entry],
  }
}

// switch.py's key_of: rows written before keys existed get theirs from the stored oauthAccount.
function keyOf(email: string, oauthAccount: Record<string, unknown> | undefined): string {
  const org = oauthAccount?.['organizationUuid']
  return `${email}#${typeof org === 'string' ? org : ''}`
}

function storedKey(a: StoredAccount): string {
  return a.key ?? keyOf(a.email, a.oauthAccount)
}

function orgOf(oauthAccount: Record<string, unknown> | undefined): string {
  const name = oauthAccount?.['organizationName']
  return typeof name === 'string' ? name : ''
}

function labelOf(a: { email: string; org: string; tier: string }): string {
  return `${a.email} (${a.tier})`
}

function tierOf(oauth: OAuthTokens | undefined): string {
  const tier = String(oauth?.rateLimitTier ?? '')
  const multiple = tier.match(/(\d+x)/)?.[1]
  const plan = String(oauth?.subscriptionType ?? '')
  return [plan, multiple].filter(Boolean).join(' ') || tier || '?'
}

export {
  SWITCH_AT,
  applyRefresh,
  byNearestReset,
  effectivePercent,
  keyOf,
  labelOf,
  leastUsed,
  needsRefresh,
  ACTIVE_READ_MS,
  backoffAfter,
  CANDIDATE_READ_MS,
  isWatched,
  retryAfterMs,
  orgOf,
  parseUsage,
  peakOf,
  savedCurrent,
  storedKey,
  switchTarget,
  tierOf,
  windowsFromRateLimits,
  withSessionLimits,
  withTokens,
}
