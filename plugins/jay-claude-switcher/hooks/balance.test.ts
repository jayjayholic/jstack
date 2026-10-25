import { expect, test } from 'claude-code/testing'
import type { AccountView } from '../types'
import { parseUsage } from './accounts'
import { balanceTarget, nextWake, planMultiple, ranked } from './balance'

const NOW = Date.parse('2026-10-24T12:00:00Z')
const SOON = '2026-10-24T14:00:00Z'
const LATER = '2026-10-24T16:00:00Z'
const NEXT_WEEK = '2026-10-30T12:00:00Z'

type Spec = { fiveHour: number; week?: number; multiple: number; fiveReset?: string; weekReset?: string }

function acct(key: string, s: Spec): AccountView {
  const windows = [{ key: 'session', label: '5h', percent: s.fiveHour, resetsAt: s.fiveReset ?? LATER, binding: true }]
  if (s.week !== undefined) windows.push({ key: 'weekly_all', label: 'week', percent: s.week, resetsAt: s.weekReset ?? NEXT_WEEK, binding: true })
  return { key, email: key, org: '', tier: `${s.multiple}x`, multiple: s.multiple, hasWeekly: s.week !== undefined, windows, fetchedAt: NOW - 1000, error: null }
}

const unlimited = (key: string, fiveHour: number, multiple = 5) => acct(key, { fiveHour, multiple })
const weekly = (key: string, fiveHour: number, week: number, multiple: number, weekReset?: string) => acct(key, { fiveHour, week, multiple, weekReset })

test('the plan size comes from rateLimitTier: 5x, 20x, Pro as 1, anything else unknown', () => {
  expect(planMultiple('default_claude_max_5x')).toBe(5)
  expect(planMultiple('default_claude_max_20x')).toBe(20)
  expect(planMultiple('default_claude_pro')).toBe(1)
  expect(planMultiple('default_claude_zero')).toBeNull()
  expect(planMultiple(undefined)).toBeNull()
})

test('no weekly row in the usage answer is no weekly limit; a weekly row at 0% is a limit with room', () => {
  const none = parseUsage({ limits: [{ kind: 'session', percent: 40, resets_at: SOON }] })
  const zero = parseUsage({ limits: [{ kind: 'session', percent: 40, resets_at: SOON }, { kind: 'weekly_all', percent: 0, resets_at: NEXT_WEEK }] })
  const legacyNull = parseUsage({ five_hour: { utilization: 40, resets_at: SOON }, seven_day: null })
  expect(none.some(w => w.label === 'week')).toBe(false)
  expect(zero.find(w => w.label === 'week')?.percent).toBe(0)
  expect(legacyNull.some(w => w.label === 'week')).toBe(false)
})

test('on a 20x weekly account, a 5x weekly account that frees up is switched to at once', () => {
  const accounts = [weekly('w20', 30, 40, 20), weekly('w5', 10, 50, 5)]
  const pick = balanceTarget(accounts, 'w20', NOW, [], false)
  expect(pick?.to).toBe('w5')
  expect(pick?.trigger).toBe('freed')
})

test('on a 5x weekly account, an account with no weekly limit that frees up is switched to at once', () => {
  const accounts = [weekly('w5', 30, 40, 5), unlimited('u', 97)]
  expect(balanceTarget(accounts, 'w5', NOW, [], false)?.to).toBe('u')
})

test('stays on the 20x while every 5x is out: 5-hour at 98% or more, or the week exhausted', () => {
  const accounts = [weekly('w20', 50, 40, 20), weekly('w5a', 98, 10, 5), weekly('w5b', 20, 99.2, 5), unlimited('u', 98.4)]
  expect(balanceTarget(accounts, 'w20', NOW, [], false)).toBeNull()
})

test('stays on a weekly account while every account with no weekly limit is at 98% or more of its 5-hour window', () => {
  const accounts = [weekly('w5', 50, 40, 5), unlimited('u1', 98), unlimited('u2', 99.5)]
  expect(balanceTarget(accounts, 'w5', NOW, [], false)).toBeNull()
})

test('running out picks an account with no weekly limit over a free weekly one, however much room the weekly one has', () => {
  const accounts = [unlimited('u1', 99), weekly('w5', 0, 0, 5), unlimited('u2', 90, 20)]
  const pick = balanceTarget(accounts, 'u1', NOW, [], true)
  expect(pick?.to).toBe('u2')
  expect(pick?.trigger).toBe('out')
})

test('nothing else swaps: not for more headroom in the same class, not to a bigger plan, not on a reading below 99%', () => {
  expect(balanceTarget([unlimited('u1', 60), unlimited('u2', 5)], 'u1', NOW, [], false)).toBeNull()
  expect(balanceTarget([weekly('a', 10, 80, 5), weekly('b', 10, 5, 5)], 'a', NOW, [], false)).toBeNull()
  expect(balanceTarget([unlimited('u5', 70, 5), unlimited('u20', 0, 20)], 'u5', NOW, [], false)).toBeNull()
  expect(balanceTarget([weekly('w5', 97, 60, 5), weekly('w20', 0, 0, 20)], 'w5', NOW, [], false)).toBeNull()
})

test('among weekly accounts of one size: the most weekly headroom first, then the soonest weekly reset', () => {
  const now = NOW
  expect(ranked([weekly('a', 0, 30, 5), weekly('b', 50, 10, 5)], null, now, []).map(a => a.key)).toEqual(['b', 'a'])
  expect(ranked([weekly('a', 0, 10, 5, NEXT_WEEK), weekly('b', 0, 10, 5, LATER)], null, now, []).map(a => a.key)).toEqual(['b', 'a'])
})

test('priority.json overrides the order: a listed account outranks every unlisted one', () => {
  const accounts = [unlimited('u', 10), weekly('w20', 10, 10, 20)]
  expect(balanceTarget(accounts, 'u', NOW, ['w20'], false)?.to).toBe('w20')
  expect(balanceTarget(accounts, 'w20', NOW, ['w20'], false)).toBeNull()
})

test('a window past its reset is free again: the account wakes up without waiting for a read', () => {
  const sleeping = acct('u', { fiveHour: 100, multiple: 5, fiveReset: SOON })
  const accounts = [weekly('w20', 10, 10, 20), sleeping]
  expect(balanceTarget(accounts, 'w20', NOW, [], false)).toBeNull()
  expect(nextWake(accounts, 'w20', NOW)).toEqual({ at: Date.parse(SOON), key: 'u', window: '5h' })
  expect(balanceTarget(accounts, 'w20', Date.parse(SOON) + 1, [], false)?.to).toBe('u')
})
