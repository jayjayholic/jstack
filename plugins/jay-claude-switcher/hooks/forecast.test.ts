import { expect, test } from 'claude-code/testing'
import { addSample, forecast, recentTrend, slopePerHour, spentPerHour, type Sample } from './forecast'

const H = 3_600_000
const T0 = Date.parse('2026-10-11T10:00:00Z')
const RESET = '2026-10-11T15:00:00Z'

const ramp = (rate: number, hours: number, reset = RESET): Sample[] =>
  Array.from({ length: hours * 4 + 1 }, (_, i) => ({ t: T0 + i * (H / 4), kind: 'five_hour', p: Math.round(i * (rate / 4) * 10) / 10, resetsAt: reset }))

test('steady 20%/h burn forecasts exhaustion about 5 h after 0%', () => {
  const samples = ramp(20, 2)
  const now = T0 + 2 * H
  const f = forecast(samples, samples[samples.length - 1]!, now)
  expect(Math.round(f.ratePerHour!)).toBe(20)
  expect(Math.round((f.etaMs! - now) / H)).toBe(3)
  expect(f.safeUntilReset).toBe(false)
})

test('slow burn that cannot reach 100% before the reset is safe', () => {
  const samples = ramp(2, 2)
  const now = T0 + 2 * H
  expect(forecast(samples, samples[samples.length - 1]!, now).safeUntilReset).toBe(true)
})

test('a single reading already forecasts from the window average', () => {
  // 5 h window resetting at 15:00 opened at 10:00; 40% used at 12:00 → 20%/h → out at 15:00.
  const now = Date.parse('2026-10-11T12:00:00Z')
  const one: Sample = { t: now, kind: 'five_hour', p: 40, resetsAt: RESET }
  const f = forecast([one], one, now)
  expect(Math.round(f.ratePerHour!)).toBe(20)
  expect(Math.round((f.etaMs! - now) / H)).toBe(3)
})

test('readings under a minute apart give no slope; a window without a reset time gives no average', () => {
  const one: Sample[] = [{ t: T0, kind: 'five_hour', p: 10, resetsAt: RESET }]
  expect(slopePerHour(one)).toBe(null)
  expect(slopePerHour([...one, { t: T0 + 30_000, kind: 'five_hour', p: 12, resetsAt: RESET }])).toBe(null)
  const bare: Sample = { t: T0, kind: 'five_hour', p: 10 }
  expect(forecast([bare], bare, T0).ratePerHour).toBe(null)
})

test('a new window (reset) is not mixed with the previous one', () => {
  const old = ramp(30, 2, '2026-10-11T09:00:00Z')
  const fresh: Sample[] = [
    { t: T0 + 2.5 * H - 30_000, kind: 'five_hour', p: 3, resetsAt: '2026-10-11T19:00:00Z' },
    { t: T0 + 2.5 * H, kind: 'five_hour', p: 4, resetsAt: '2026-10-11T19:00:00Z' },
  ]
  const f = forecast([...old, ...fresh], fresh[1]!, T0 + 2.5 * H)
  expect(Math.round(f.ratePerHour!)).toBe(120)
})

test('duplicates within 5 seconds are not stored twice, 10 seconds later they are', () => {
  const a: Sample = { t: T0, kind: 'five_hour', p: 10, resetsAt: RESET }
  expect(addSample(addSample([], a), { ...a, t: T0 + 3_000 })).toHaveLength(1)
  expect(addSample(addSample([], a), { ...a, t: T0 + 10_000 })).toHaveLength(2)
})

test('the last 10 readings give a rising sparkline and their change', () => {
  const samples = ramp(12, 3)
  const { spark, delta } = recentTrend(samples, 'five_hour', 10)
  expect(spark).toHaveLength(10)
  expect(spark[0]).toBe('▁')
  expect(spark[9]).toBe('█')
  expect(delta).toBe(27)
})

test('one reading is not a trend', () => {
  expect(recentTrend([{ t: T0, kind: 'five_hour', p: 5 }], 'five_hour', 10)).toEqual({ spark: '', delta: null })
})

test('spent per hour sums increases inside each hour', () => {
  const samples = ramp(8, 2)
  const hours = spentPerHour(samples, 'five_hour', T0 + 2 * H - 1, 2)
  expect(hours.map(h => h.spent)).toEqual([6, 6])
})

test('the rate comes from the last minute only; older readings in the window are ignored', () => {
  const samples: Sample[] = [
    { t: T0, kind: 'five_hour', p: 10, resetsAt: RESET },
    { t: T0 + H - 60_000, kind: 'five_hour', p: 50, resetsAt: RESET },
    { t: T0 + H - 20_000, kind: 'five_hour', p: 50, resetsAt: RESET },
    { t: T0 + H, kind: 'five_hour', p: 50, resetsAt: RESET },
  ]
  expect(forecast(samples, samples[3]!, T0 + H).ratePerHour).toBe(0)
})
