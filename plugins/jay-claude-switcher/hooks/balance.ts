import type { AccountView, UsageWindow } from '../types'
import { SWITCH_AT, effectivePercent, isAuthError, labelOf } from './accounts'

// An account is free for the balancer while its 5-hour window is under 98% and its weekly window is not exhausted.
const FREE_BELOW = 98
// The tiers, best first: no weekly limit, then weekly-limited; inside each, the smaller plan first.
const NO_WEEKLY = 0
const WEEKLY = 1
const UNKNOWN_PLAN = 1_000

type Trigger = 'freed' | 'out'
type Pick = { to: string; label: string; reason: string; trigger: Trigger }

// The plan's size from the stored credentials' `rateLimitTier` (`default_claude_max_5x`, `default_claude_max_20x`);
// a Pro plan reads as 1, anything else as unknown.
function planMultiple(rateLimitTier: unknown): number | null {
  const tier = typeof rateLimitTier === 'string' ? rateLimitTier : ''
  const n = tier.match(/(\d+)x/)?.[1]
  if (n) return Number(n)
  return /pro/i.test(tier) ? 1 : null
}

function windowOf(a: AccountView, label: string): UsageWindow | undefined {
  return a.windows.find(w => w.binding && w.label === label)
}

// Whether a weekly limit applies: the usage endpoint lists the meters that apply, so an answer with no weekly_all
// row (or a null seven_day) has none, while a weekly row at 0% is a limit with room. Unknown until a usage read.
function hasWeeklyLimit(a: AccountView): boolean | null {
  if (a.hasWeekly != null) return a.hasWeekly
  return windowOf(a, 'week') ? true : null
}

function tierOfAccount(a: AccountView): number {
  return hasWeeklyLimit(a) === false ? NO_WEEKLY : WEEKLY
}

function overrideIndex(a: AccountView, order: readonly string[]): number {
  return order.findIndex(o => o === a.key || o === a.email)
}

// The priority class: a lower class is better. Accounts named in priority.json come first, in that order; the rest
// go by tier (no weekly limit before weekly-limited, an unread account counting as weekly-limited) and plan size.
function classOf(a: AccountView, order: readonly string[]): number[] {
  const listed = overrideIndex(a, order)
  if (listed >= 0) return [0, listed]
  return [1, tierOfAccount(a), a.multiple ?? UNKNOWN_PLAN]
}

function compareClass(x: readonly number[], y: readonly number[]): number {
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d) return d
  }
  return 0
}

function percentOf(a: AccountView, label: string, now: number): number {
  const w = windowOf(a, label)
  return w ? effectivePercent(w, now) : 0
}

function resetOf(a: AccountView, label: string, now: number): number {
  const at = windowOf(a, label)?.resetsAt ? Date.parse(windowOf(a, label)!.resetsAt!) : Number.NaN
  return Number.isNaN(at) || at <= now ? Number.MAX_SAFE_INTEGER : at
}

function isAvailable(a: AccountView, now: number): boolean {
  if (a.fetchedAt === null || isAuthError(a.error) || !a.windows.some(w => w.binding)) return false
  return percentOf(a, '5h', now) < FREE_BELOW && percentOf(a, 'week', now) < SWITCH_AT
}

// Inside one class: a weekly-limited account with the most weekly headroom first, then the soonest weekly reset;
// otherwise the lowest 5-hour use, then the soonest 5-hour reset; last, the store's order.
function tieBreak(x: AccountView, y: AccountView, now: number): number {
  if (tierOfAccount(x) === WEEKLY && tierOfAccount(y) === WEEKLY) {
    const d = percentOf(x, 'week', now) - percentOf(y, 'week', now) || resetOf(x, 'week', now) - resetOf(y, 'week', now)
    if (d) return d
  }
  return percentOf(x, '5h', now) - percentOf(y, '5h', now) || resetOf(x, '5h', now) - resetOf(y, '5h', now)
}

function ranked(accounts: readonly AccountView[], exclude: string | null, now: number, order: readonly string[]): AccountView[] {
  return accounts
    .map((a, i) => ({ a, i }))
    .filter(({ a }) => a.key !== exclude && isAvailable(a, now))
    .sort((x, y) => compareClass(classOf(x.a, order), classOf(y.a, order)) || tieBreak(x.a, y.a, now) || x.i - y.i)
    .map(x => x.a)
}

function describeClass(a: AccountView, order: readonly string[]): string {
  const listed = overrideIndex(a, order)
  if (listed >= 0) return `#${listed + 1} in priority.json`
  const plan = a.multiple ? `${a.multiple}x plan` : 'plan size unknown'
  const weekly = hasWeeklyLimit(a)
  return `${weekly === false ? 'no weekly limit' : weekly === true ? 'weekly-limited' : 'weekly limit unknown'}, ${plan}`
}

// The only two reasons to swap. `out`: the current account ran out in its window (the 99% check or a limit error,
// `due`); go to the best free account. `freed`: a free account of a strictly better class exists; go to it now.
// Nothing else swaps: never for more headroom inside the same class.
function balanceTarget(accounts: readonly AccountView[], activeKey: string | null, now: number, order: readonly string[], due: boolean): Pick | null {
  const current = accounts.find(a => a.key === activeKey)
  const best = ranked(accounts, activeKey, now, order)[0]
  if (!best) return null
  const why = describeClass(best, order)
  if (due) {
    const at = current ? Math.round(Math.max(percentOf(current, '5h', now), percentOf(current, 'week', now))) : null
    return { to: best.key, label: labelOf(best), trigger: 'out', reason: `${current ? labelOf(current) : 'current'} ran out (${at}%); best free account: ${why}` }
  }
  if (!current || compareClass(classOf(best, order), classOf(current, order)) >= 0) return null
  return { to: best.key, label: labelOf(best), trigger: 'freed', reason: `${labelOf(best)} is free and ranks higher (${why}) than ${labelOf(current)} (${describeClass(current, order)})` }
}

// When the balancer next has something to look at: the soonest reset, after now, of an account that is not free.
function nextWake(accounts: readonly AccountView[], activeKey: string | null, now: number): { at: number; key: string; window: string } | null {
  let next: { at: number; key: string; window: string } | null = null
  for (const a of accounts) {
    if (a.key === activeKey || isAvailable(a, now) || isAuthError(a.error)) continue
    for (const w of a.windows.filter(x => x.binding && x.resetsAt)) {
      const at = Date.parse(w.resetsAt!)
      if (!Number.isNaN(at) && at > now && (!next || at < next.at)) next = { at, key: a.key, window: w.label }
    }
  }
  return next
}

// An account whose window reset since its last read is read again, to confirm it is free.
function wokenUp(a: AccountView, now: number): boolean {
  if (a.fetchedAt === null) return false
  return a.windows.some(w => w.binding && w.resetsAt && Date.parse(w.resetsAt) <= now && Date.parse(w.resetsAt) > a.fetchedAt!)
}

export { FREE_BELOW, balanceTarget, classOf, describeClass, hasWeeklyLimit, isAvailable, nextWake, planMultiple, ranked, wokenUp }
export type { Pick }
