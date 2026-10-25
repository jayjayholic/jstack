// Small statistics kit shared by /unslop (rule precision) and /optimize (A/B runs): Wilson score interval for a
// proportion, Hodges-Lehmann shift estimate with a distribution-free confidence interval, and Cliff's delta.

const Z95 = 1.959963984540054

// Wilson score interval (Wilson 1927): good for small n and proportions near 0 or 1.
function wilson(k, n, z = Z95) {
  if (!n) return { p: null, lower: 0, upper: 1 }
  const p = k / n
  const d = 1 + (z * z) / n
  const c = (p + (z * z) / (2 * n)) / d
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d
  return { p, lower: Math.max(0, c - h), upper: Math.min(1, c + h) }
}

// Hodges-Lehmann estimate of the shift b - a: median of all pairwise differences, with the Mann-Whitney based
// interval (normal approximation of the rank of the order statistics; fine for n >= 10 per arm).
function hodgesLehmann(a, b, z = Z95) {
  const diffs = []
  for (const x of a) for (const y of b) diffs.push(y - x)
  diffs.sort((p, q) => p - q)
  const n = diffs.length
  if (!n) return { estimate: null, lower: null, upper: null }
  const median = n % 2 ? diffs[(n - 1) / 2] : (diffs[n / 2 - 1] + diffs[n / 2]) / 2
  const m = a.length, k = b.length
  const ca = Math.floor((m * k) / 2 - z * Math.sqrt((m * k * (m + k + 1)) / 12))
  const lo = Math.max(0, ca)
  const hi = Math.min(n - 1, n - 1 - ca)
  return { estimate: median, lower: diffs[lo], upper: diffs[hi] }
}

// Cliff's delta: P(b > a) - P(b < a), in [-1, 1]. |d| < 0.147 negligible, < 0.33 small, < 0.474 medium, else large.
function cliffsDelta(a, b) {
  if (!a.length || !b.length) return { delta: null, magnitude: null }
  let gt = 0, lt = 0
  for (const x of a) for (const y of b) { if (y > x) gt++; else if (y < x) lt++ }
  const delta = (gt - lt) / (a.length * b.length)
  const ad = Math.abs(delta)
  const magnitude = ad < 0.147 ? 'negligible' : ad < 0.33 ? 'small' : ad < 0.474 ? 'medium' : 'large'
  return { delta, magnitude }
}

export { wilson, hodgesLehmann, cliffsDelta, Z95 }
