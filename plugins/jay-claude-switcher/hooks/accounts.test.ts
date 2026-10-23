import { expect, test } from 'claude-code/testing'
import type { AccountView, OAuthTokens } from '../types'
import { applyRefresh, byNearestReset, keyOf, leastUsed, backoffAfter, isWatched, markLimitHit, noTargetReason, needsRefresh, peakOf, retryAfterMs, withSessionLimits, parseUsage, savedCurrent, switchTarget, withTokens } from './accounts'

const NOW = Date.parse('2026-10-23T12:00:00Z')
const LATER = '2026-10-23T15:00:00Z'
const PAST = '2026-10-23T11:00:00Z'

function account(email: string, fiveHour: number, week: number, over: Partial<AccountView> = {}): AccountView {
  return {
    key: `${email}#org`,
    email,
    org: '',
    tier: 'max 20x',
    windows: [
      { key: 'session', label: '5h', percent: fiveHour, resetsAt: LATER, binding: true },
      { key: 'weekly_all', label: 'week', percent: week, resetsAt: LATER, binding: true },
      { key: 'weekly_scoped:Fable', label: 'wk Fable', percent: 100, resetsAt: LATER, binding: false },
    ],
    fetchedAt: NOW,
    error: null,
    ...over,
  }
}

test('parses the limits list /usage draws, keeping only the 5h and all-models weekly windows', () => {
  const windows = parseUsage({
    five_hour: { utilization: 79, resets_at: LATER },
    limits: [
      { kind: 'session', group: 'session', percent: 79, resets_at: LATER, scope: null },
      { kind: 'weekly_all', group: 'weekly', percent: 11, resets_at: LATER, scope: null },
      { kind: 'weekly_scoped', group: 'weekly', percent: 0, resets_at: LATER, scope: { model: { display_name: 'Fable' } } },
    ],
  })
  expect(windows.map(w => [w.label, w.percent, w.binding])).toEqual([
    ['5h', 79, true],
    ['week', 11, true],
  ])
})

test('falls back to the per-window fields, and skips empty ones', () => {
  const windows = parseUsage({ five_hour: { utilization: 40, resets_at: LATER }, seven_day: { utilization: 5, resets_at: null }, seven_day_opus: { utilization: 90, resets_at: null } })
  expect(windows.map(w => w.label)).toEqual(['5h', 'week'])
  expect(parseUsage({})).toEqual([])
  expect(parseUsage(null)).toEqual([])
})

test('picks the least-used account by its highest binding window, ignoring scoped weekly ones', () => {
  const accounts = [account('a@example.com', 99.9, 10), account('b@example.com', 20, 60), account('c@example.com', 30, 30), account('d@example.com', 5, 99.9)]
  expect(leastUsed(accounts, 'a@example.com#org', NOW)?.email).toBe('c@example.com')
})

test('never picks an account with an error, no reading, or no headroom', () => {
  const accounts = [
    account('a@example.com', 99.9, 10),
    account('b@example.com', 0, 0, { error: 'refused (HTTP 401)' }),
    account('c@example.com', 0, 0, { fetchedAt: null }),
    account('d@example.com', 99.95, 0),
  ]
  expect(leastUsed(accounts, 'a@example.com#org', NOW)).toBeNull()
})

test('the 99.9% trigger fires on the 5h or the weekly window of the active account', () => {
  expect(switchTarget([account('a@example.com', 99.9, 10), account('b@example.com', 50, 50)], 'a@example.com#org', NOW)?.to).toBe('b@example.com#org')
  expect(switchTarget([account('a@example.com', 10, 99.92), account('b@example.com', 50, 50)], 'a@example.com#org', NOW)?.to).toBe('b@example.com#org')
  expect(switchTarget([account('a@example.com', 98.9, 98), account('b@example.com', 0, 0)], 'a@example.com#org', NOW)).toBeNull()
})

test('does not switch when no other account has headroom', () => {
  expect(switchTarget([account('a@example.com', 100, 10), account('b@example.com', 99.9, 0), account('c@example.com', 0, 100)], 'a@example.com#org', NOW)).toBeNull()
  expect(switchTarget([account('a@example.com', 100, 10)], 'a@example.com#org', NOW)).toBeNull()
})

test('one email with two organizations is two accounts: the other one is a switch target', () => {
  const twenty = account('me@example.com', 100, 10, { key: 'me@example.com#org20' })
  const five = account('me@example.com', 10, 10, { key: 'me@example.com#org5', tier: 'max 5x' })
  expect(switchTarget([twenty, five], 'me@example.com#org20', NOW)).toMatchObject({ to: 'me@example.com#org5', label: 'me@example.com (max 5x)' })
  expect(keyOf('me@example.com', { organizationUuid: 'org5' })).toBe('me@example.com#org5')
  expect(keyOf('me@example.com', {})).toBe('me@example.com#')
})

test('a window past its reset reads as empty, so it neither triggers nor blocks', () => {
  const reset = account('a@example.com', 100, 10)
  reset.windows[0] = { ...reset.windows[0]!, resetsAt: PAST }
  expect(switchTarget([reset, account('b@example.com', 0, 0)], 'a@example.com#org', NOW)).toBeNull()
  const free = account('b@example.com', 100, 10)
  free.windows[0] = { ...free.windows[0]!, resetsAt: PAST }
  expect(switchTarget([account('a@example.com', 100, 0), free], 'a@example.com#org', NOW)?.to).toBe('b@example.com#org')
})

test('a refresh replaces both tokens and the expiry, keeping the other fields', () => {
  const old: OAuthTokens = { accessToken: 'old-a', refreshToken: 'old-r', expiresAt: NOW - 1, scopes: ['user:inference'], subscriptionType: 'max' }
  const next = applyRefresh(old, { access_token: 'new-a', refresh_token: 'new-r', expires_in: 3600, scope: 'user:inference user:profile' }, NOW)
  expect(next).toMatchObject({ accessToken: 'new-a', refreshToken: 'new-r', expiresAt: NOW + 3_600_000, subscriptionType: 'max' })
  expect(next.scopes).toEqual(['user:inference', 'user:profile'])
  expect(applyRefresh(old, { access_token: 'n', expires_in: 60 }, NOW).refreshToken).toBe('old-r')
  expect(() => applyRefresh(old, { error: 'invalid_grant' } as never, NOW)).toThrow()
  expect(needsRefresh(old, NOW)).toBe(true)
  expect(needsRefresh(next, NOW)).toBe(false)
})

test('the store keeps its order: rotated tokens replace one row, a new login is appended', () => {
  const tokens = (t: string): OAuthTokens => ({ accessToken: t, refreshToken: t, expiresAt: NOW })
  const store = {
    accounts: [
      { email: 'a@example.com', savedAt: 's', oauthAccount: {}, claudeAiOauth: tokens('a') },
      { key: 'b@example.com#o2', email: 'b@example.com', savedAt: 's', oauthAccount: { organizationUuid: 'o2' }, claudeAiOauth: tokens('b') },
    ],
  }
  expect(withTokens(store, 'a@example.com#', tokens('a2')).accounts.map(a => a.claudeAiOauth.accessToken)).toEqual(['a2', 'b'])
  const saved = savedCurrent(store, { key: 'b@example.com#o3', email: 'b@example.com', oauthAccount: { emailAddress: 'b@example.com' }, oauth: tokens('c') }, 'now')
  expect(saved.accounts.map(a => a.key ?? a.email)).toEqual(['a@example.com', 'b@example.com#o2', 'b@example.com#o3'])
  const replaced = savedCurrent(store, { key: 'b@example.com#o2', email: 'b@example.com', oauthAccount: {}, oauth: tokens('b2') }, 'now')
  expect(replaced.accounts.map(a => a.claudeAiOauth.accessToken)).toEqual(['a', 'b2'])
  expect(savedCurrent(store, { key: null, email: null, oauthAccount: {}, oauth: null }, 'now')).toBe(store)
})

test('an account with no weekly window is limited by its 5h window alone', () => {
  const team = account('team@example.com', 30, 0, { key: 'team@example.com#t' })
  team.windows = team.windows.filter(w => w.label !== 'week')
  const capped = account('a@example.com', 100, 10)
  const weeklyFull = account('b@example.com', 0, 99.95)
  expect(peakOf(team, NOW)).toBe(30)
  expect(switchTarget([capped, weeklyFull, team], 'a@example.com#org', NOW)?.to).toBe('team@example.com#t')
  team.windows[0] = { ...team.windows[0]!, percent: 99.9 }
  expect(switchTarget([team, capped], 'team@example.com#t', NOW)).toBeNull()
})

test('the usage endpoint is only watched from 98% on a binding window', () => {
  expect(isWatched(account('a@example.com', 98, 10), NOW)).toBe(true)
  expect(isWatched(account('a@example.com', 10, 98.4), NOW)).toBe(true)
  expect(isWatched(account('a@example.com', 97.9, 50), NOW)).toBe(false)
  expect(isWatched({ ...account('a@example.com', 0, 0), windows: [] }, NOW)).toBe(false)
  expect(isWatched(undefined, NOW)).toBe(false)
})

test('a failed read backs off by Retry-After, else 5 minutes doubling up to 30', () => {
  expect(backoffAfter(undefined, '120', NOW)).toEqual({ until: NOW + 120_000, step: 300_000 })
  expect(backoffAfter(undefined, new Date(NOW + 90_000).toUTCString(), NOW).until).toBe(NOW + 90_000)
  let b = backoffAfter(undefined, undefined, NOW)
  expect(b).toEqual({ until: NOW + 300_000, step: 300_000 })
  b = backoffAfter(b, undefined, NOW)
  expect(b.step).toBe(600_000)
  for (let i = 0; i < 5; i++) b = backoffAfter(b, undefined, NOW)
  expect(b).toEqual({ until: NOW + 1_800_000, step: 1_800_000 })
  expect(backoffAfter(undefined, 'soon', NOW).until).toBe(NOW + 300_000)
})

test('Retry-After reads seconds and HTTP dates and ignores junk', () => {
  expect(retryAfterMs('0', NOW)).toBe(0)
  expect(retryAfterMs('', NOW)).toBeNull()
  expect(retryAfterMs(undefined, NOW)).toBeNull()
  expect(retryAfterMs('-5', NOW)).toBeNull()
  expect(retryAfterMs(new Date(NOW - 5000).toUTCString(), NOW)).toBe(0)
})

test('the session headers update the current account, so 98% is seen between full reads', () => {
  const merged = withSessionLimits(account('a@example.com', 40, 10).windows, [{ kind: 'five_hour', percentUsed: 98.2, resetsAt: LATER }])
  expect(merged.find(w => w.label === '5h')?.percent).toBe(98.2)
  expect(merged.find(w => w.label === 'week')?.percent).toBe(10)
  expect(isWatched({ ...account('a@example.com', 40, 10), windows: merged }, NOW)).toBe(true)
  expect(withSessionLimits(account('a@example.com', 40, 10).windows, [{ kind: 'spend_limit', percentUsed: 5 }]).find(w => w.label === '5h')?.percent).toBe(40)
})

test('rows sort by nearest availability: weekly-full accounts wait for the weekly reset, others go by their 5h reset', () => {
  const at = (h: number) => new Date(NOW + h * 3_600_000).toISOString()
  const make = (email: string, five: number, fiveReset: number | null, week: number | null, weekReset: number) => {
    const a = account(email, five, week ?? 0)
    a.windows = [
      { key: 'session', label: '5h', percent: five, resetsAt: fiveReset === null ? null : at(fiveReset), binding: true },
      ...(week === null ? [] : [{ key: 'weekly_all', label: 'week', percent: week, resetsAt: at(weekReset), binding: true }]),
    ]
    return a
  }
  const weekFullSoon = make('week-soon@example.com', 0, 4, 100, 24)
  const weekFullLate = make('week-late@example.com', 0, 1, 100, 120)
  const fiveIn2 = make('five-2h@example.com', 99.9, 2, 40, 100)
  const fiveIn3 = make('five-3h@example.com', 20, 3, null, 0)
  const fiveIn2b = make('five-2h-b@example.com', 50, 2, 10, 50)
  const noReset = make('idle@example.com', 0, null, 5, 150)
  const sorted = byNearestReset([weekFullLate, fiveIn3, weekFullSoon, fiveIn2, noReset, fiveIn2b], NOW).map(a => a.email)
  expect(sorted).toEqual(['idle@example.com', 'five-2h-b@example.com', 'five-2h@example.com', 'five-3h@example.com', 'week-soon@example.com', 'week-late@example.com'])
})

test('switching starts at 99%: a busy (429) candidate keeps its last reading, a refused one is skipped', () => {
  const busy = account('b@example.com', 2, 14, { error: 'usage API busy (429), waiting before the next read' })
  const refused = account('c@example.com', 0, 0, { error: 'refused (HTTP 401)' })
  expect(switchTarget([account('a@example.com', 99, 10), busy, refused], 'a@example.com#org', NOW)?.to).toBe('b@example.com#org')
  expect(switchTarget([account('a@example.com', 98.9, 10), busy], 'a@example.com#org', NOW)).toBeNull()
  expect(switchTarget([account('a@example.com', 99, 10), refused], 'a@example.com#org', NOW)).toBeNull()
})

test('with no reading below 99%, an account never read is tried; a refused or full one is not', () => {
  const unread = { ...account('u@example.com', 0, 0), windows: [], fetchedAt: null }
  expect(switchTarget([account('a@example.com', 100, 10), account('b@example.com', 100, 0), unread], 'a@example.com#org', NOW)?.to).toBe('u@example.com#org')
  expect(switchTarget([account('a@example.com', 100, 10), { ...unread, error: 'login expired: sign in again and import it' }], 'a@example.com#org', NOW)).toBeNull()
  expect(switchTarget([account('a@example.com', 100, 10), account('b@example.com', 99.2, 0)], 'a@example.com#org', NOW)).toBeNull()
})

test('a limit error marks the 5h window full, or the weekly one when it says so; other windows stay', () => {
  const marked = markLimitHit(account('a@example.com', 40, 10).windows, "You've hit your session limit", NOW)
  expect(marked.map(w => w.percent)).toEqual([100, 10, 100])
  expect(markLimitHit(account('a@example.com', 40, 10).windows, 'weekly limit reached', NOW).map(w => w.percent)).toEqual([40, 100, 100])
  expect(markLimitHit([], '', NOW)).toEqual([{ key: 'session', label: '5h', percent: 100, resetsAt: null, binding: true }])
})

test('the no-target status names why: nothing else stored, all full, or logins expired', () => {
  expect(noTargetReason([account('a@example.com', 100, 0)], 'a@example.com#org', NOW)).toContain('no other account stored')
  const why = noTargetReason([account('a@example.com', 100, 0), account('b@example.com', 99.5, 0), account('c@example.com', 0, 0, { error: 'refused (HTTP 403)' })], 'a@example.com#org', NOW)
  expect(why).toContain('1 at 99% or more')
  expect(why).toContain('1 with an expired login')
})
