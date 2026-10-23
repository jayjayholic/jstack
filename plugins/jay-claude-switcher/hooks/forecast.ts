import type { Row, Tone } from '../types'

// A reading of one rate-limit window at one moment, kept across sessions.
type Sample = { t: number; kind: string; p: number; resetsAt?: string }

type Forecast = {
  kind: string
  percent: number
  ratePerHour: number | null
  etaMs: number | null
  etaLowMs: number | null
  etaHighMs: number | null
  resetsAtMs: number | null
  safeUntilReset: boolean
}

const HOUR = 3_600_000
const KEEP_MS = 8 * 24 * HOUR
const MAX_SAMPLES = 25_000

function sameWindow(a: Sample, b: Sample): boolean {
  return a.kind === b.kind && (a.resetsAt ?? '') === (b.resetsAt ?? '')
}

// Adds a reading; drops near-duplicates (same window, same percent within 5 s) and anything older than 8 days.
function addSample(samples: Sample[], next: Sample): Sample[] {
  const last = [...samples].reverse().find(s => s.kind === next.kind)
  const duplicate = last && sameWindow(last, next) && last.p === next.p && next.t - last.t < 5_000
  const kept = duplicate ? samples : [...samples, next]
  return kept.filter(s => next.t - s.t <= KEEP_MS).slice(-MAX_SAMPLES)
}

// Least-squares slope in percent per hour over readings of the current window inside the lookback.
function slopePerHour(points: Sample[], minSpanMs = 60_000): number | null {
  if (points.length < 2) return null
  const span = points[points.length - 1]!.t - points[0]!.t
  if (span < minSpanMs) return null
  const xs = points.map(s => (s.t - points[0]!.t) / HOUR)
  const ys = points.map(s => s.p)
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length
  const my = ys.reduce((a, b) => a + b, 0) / ys.length
  let num = 0
  let den = 0
  xs.forEach((x, i) => {
    num += (x - mx) * (ys[i]! - my)
    den += (x - mx) ** 2
  })
  return den === 0 ? null : num / den
}

function etaFrom(now: number, percent: number, rate: number | null): number | null {
  if (rate === null || rate <= 0.01) return null
  return now + ((100 - percent) / rate) * HOUR
}

const WINDOW_MS: Record<string, number> = { five_hour: 5 * HOUR, seven_day: 7 * 24 * HOUR }

// Average burn since the window opened (resetsAt minus its length): a rate from a single reading.
function windowRate(latest: Sample, now: number): number | null {
  const length = WINDOW_MS[latest.kind]
  if (!latest.resetsAt || !length) return null
  const elapsedH = (now - (Date.parse(latest.resetsAt) - length)) / HOUR
  return elapsedH > 0.05 ? latest.p / elapsedH : null
}

// Forecast for one window: the slope of the last minute of readings (owner's choice), else the window's average since
// it opened; the range spans the last-minute slope and the window average.
function forecast(samples: Sample[], latest: Sample, now: number): Forecast {
  const current = samples.filter(s => sameWindow(s, latest)).sort((a, b) => a.t - b.t)
  const lastMinute = current.filter(s => now - s.t <= 60_000)
  const average = windowRate(latest, now)
  const slope = slopePerHour(lastMinute, 10_000)
  const rate = slope ?? average
  const etas = [slope, average]
    .map(r => etaFrom(now, latest.p, r))
    .filter((v): v is number => v !== null)
  const etaMs = etaFrom(now, latest.p, rate)
  const resetsAtMs = latest.resetsAt ? Date.parse(latest.resetsAt) : null
  return {
    kind: latest.kind,
    percent: latest.p,
    ratePerHour: rate,
    etaMs,
    etaLowMs: etas.length ? Math.min(...etas) : null,
    etaHighMs: etas.length ? Math.max(...etas) : null,
    resetsAtMs,
    safeUntilReset: resetsAtMs !== null && (etaMs === null || etaMs > resetsAtMs),
  }
}

// Percent spent in each of the last `hours` clock hours, for one window kind.
function spentPerHour(samples: Sample[], kind: string, now: number, hours: number): { hourStartMs: number; spent: number }[] {
  const series = samples.filter(s => s.kind === kind).sort((a, b) => a.t - b.t)
  const start = Math.floor(now / HOUR) * HOUR
  return Array.from({ length: hours }, (_, i) => {
    const from = start - (hours - 1 - i) * HOUR
    const inHour = series.filter(s => s.t >= from && s.t < from + HOUR)
    let spent = 0
    for (let j = 1; j < inHour.length; j++) {
      const delta = inHour[j]!.p - inHour[j - 1]!.p
      if (sameWindow(inHour[j]!, inHour[j - 1]!) && delta > 0) spent += delta
    }
    return { hourStartMs: from, spent: Math.round(spent * 10) / 10 }
  })
}

const LABEL: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }

function clock(ms: number): string {
  const d = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')
  const sameDay = new Date().toDateString() === d.toDateString()
  const day = sameDay ? '' : `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} `
  return `${day}${two(d.getHours())}:${two(d.getMinutes())}`
}

function span(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${m}m`
}

function describe(f: Forecast, now: number): string {
  const name = LABEL[f.kind] ?? f.kind
  const head = `${name} ${f.percent}%`
  if (f.ratePerHour === null) return `${head} · collecting`
  const rate = `${f.ratePerHour.toFixed(1)}%/h`
  const reset = f.resetsAtMs ? ` · resets ${clock(f.resetsAtMs)}` : ''
  if (f.safeUntilReset || f.etaMs === null) return `${head} · ${rate} · ok until reset${reset}`
  const half =
    f.etaLowMs !== null && f.etaHighMs !== null ? ` (±${span((f.etaHighMs - f.etaLowMs) / 2)})` : ''
  return `${head} · ${rate} · out ~${clock(f.etaMs)}${half} in ${span(f.etaMs - now)}${reset}`
}

// The last `n` readings of one window kind, oldest first, as a sparkline and the change across them.
function recentTrend(samples: Sample[], kind: string, n: number): { spark: string; delta: number | null } {
  const last = samples.filter(s => s.kind === kind).sort((a, b) => a.t - b.t).slice(-n)
  if (last.length < 2) return { spark: '', delta: null }
  const ticks = '▁▂▃▄▅▆▇█'
  const lo = Math.min(...last.map(s => s.p))
  const hi = Math.max(...last.map(s => s.p))
  const spark = last.map(s => ticks[hi === lo ? 0 : Math.round(((s.p - lo) / (hi - lo)) * (ticks.length - 1))]).join('')
  return { spark, delta: Math.round((last[last.length - 1]!.p - last[0]!.p) * 10) / 10 }
}

// One band row: risk tone is red when the window runs out within the hour or is past 85%, yellow when it runs out before the reset or is past 60%.
function rowOf(f: Forecast, now: number, samples: Sample[] = []): Row {
  const { spark, delta } = recentTrend(samples, f.kind, 10)
  const label = LABEL[f.kind] ?? f.kind
  const reset = f.resetsAtMs ? clock(f.resetsAtMs) : null
  const rate = f.ratePerHour === null ? null : `${f.ratePerHour.toFixed(1)}%/h`
  const runsOut = !f.safeUntilReset && f.etaMs !== null
  const half =
    runsOut && f.etaLowMs !== null && f.etaHighMs !== null ? ` ±${span((f.etaHighMs - f.etaLowMs) / 2)}` : ''
  const eta =
    f.ratePerHour === null ? 'collecting' : runsOut ? `out ~${clock(f.etaMs!)}${half} (in ${span(f.etaMs! - now)})` : 'ok until reset'
  const urgent = (runsOut && f.etaMs! - now < 3_600_000) || f.percent >= 85
  const tone: Tone = urgent ? 'error' : runsOut || f.percent >= 60 ? 'warning' : 'success'
  const brief =
    f.ratePerHour === null ? '…' : runsOut ? `out ${clock(f.etaMs!)}` : reset ? `ok ↻${reset}` : 'ok'
  return { label, percent: f.percent, rate, eta, reset, tone, spark, delta, brief }
}

export { addSample, describe, forecast, recentTrend, rowOf, slopePerHour, spentPerHour, clock }
export type { Forecast, Sample }
