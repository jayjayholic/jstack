// Shared secret detection and redaction for every jstack writer (memory entries, evidence logs, retro mining, reports).
// scan() returns where a secret is and which detector saw it, never the value. redact() replaces each hit with
// [REDACTED:<detector>]. Plain Node, no dependencies; gitleaks is used too when installed and asked for.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const SECRET_NAME = '(?:SECRET|TOKEN|PASSWORD|PASSWD|PWD|API_?KEY|PRIVATE_KEY|ACCESS_KEY|CLIENT_SECRET|AUTH|CREDENTIAL)'
const PLACEHOLDER = /^(?:\$\{?|<|\{\{|\*{3,}|x{4,}|changeme|example|placeholder|your[_-]|redacted|\[REDACTED)/i

const DETECTORS = [
  { id: 'private-key', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/g },
  { id: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
  { id: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: 'openai-key', re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g },
  { id: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'stripe-key', re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { id: 'connection-string-password', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/'"]+:([^\s@/'"]{3,})@/gi, group: 1 },
  { id: 'authorization-header', re: /\bAuthorization["']?\s*[:=]\s*["']?(?:Bearer|Basic|Token)\s+([A-Za-z0-9._~+/=-]{8,})/gi, group: 1 },
  { id: 'env-assignment', re: new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?[A-Z0-9_]*${SECRET_NAME}[A-Z0-9_]*\\s*=\\s*["']?([^\\s"'#]{8,})`, 'g'), group: 1 },
  { id: 'high-entropy', re: /(?:key|secret|token|password|passwd|credential)s?["']?\s*[:=]\s*["']?([A-Za-z0-9+/_=.-]{24,})/gi, group: 1, entropy: 4.0 },
]

function shannon(s) {
  const f = new Map()
  for (const ch of s) f.set(ch, (f.get(ch) ?? 0) + 1)
  let h = 0
  for (const n of f.values()) { const p = n / s.length; h -= p * Math.log2(p) }
  return h
}

function gitleaksHits(text) {
  const probe = spawnSync('gitleaks', ['version'], { encoding: 'utf8' })
  if (probe.status !== 0) return []
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jstack-leaks-'))
  try {
    const src = path.join(dir, 'input.txt')
    const out = path.join(dir, 'report.json')
    fs.writeFileSync(src, text)
    spawnSync('gitleaks', ['detect', '--no-git', '--source', src, '--report-format', 'json', '--report-path', out, '--no-banner'], { encoding: 'utf8' })
    return hitsFromGitleaksRows(text, JSON.parse(fs.readFileSync(out, 'utf8') || '[]'))
  } catch { return [] } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

// gitleaks reports a secret once per finding, but the same value can sit in the text many times (a token pasted
// twice, a log line repeated). Every occurrence becomes a hit, or redact() would leave the copies in clear text.
function hitsFromGitleaksRows(text, rows) {
  const hits = []
  const seen = new Set()
  for (const r of rows ?? []) {
    const secret = typeof r?.Secret === 'string' ? r.Secret : ''
    if (!secret || seen.has(secret)) continue
    seen.add(secret)
    for (let idx = text.indexOf(secret); idx >= 0; idx = text.indexOf(secret, idx + secret.length)) {
      hits.push({ detector: `gitleaks:${r.RuleID ?? 'unknown'}`, index: idx, length: secret.length })
    }
  }
  return hits
}

// Every hit as { detector, index, length }; overlapping hits are merged (first detector wins).
function scan(text, { gitleaks = false, gitleaksRows = null } = {}) {
  if (typeof text !== 'string' || !text) return []
  const hits = []
  for (const d of DETECTORS) {
    d.re.lastIndex = 0
    let m
    while ((m = d.re.exec(text))) {
      const value = d.group ? m[d.group] : m[0]
      if (!value) continue
      if (d.group && PLACEHOLDER.test(value)) continue
      if (d.entropy && shannon(value) < d.entropy) continue
      const index = d.group ? m.index + m[0].lastIndexOf(value) : m.index
      hits.push({ detector: d.id, index, length: value.length })
      if (m[0].length === 0) d.re.lastIndex++
    }
  }
  if (gitleaksRows) hits.push(...hitsFromGitleaksRows(text, gitleaksRows))
  else if (gitleaks) hits.push(...gitleaksHits(text))
  hits.sort((a, b) => a.index - b.index || b.length - a.length)
  const merged = []
  for (const h of hits) {
    const last = merged[merged.length - 1]
    if (last && h.index < last.index + last.length) continue
    merged.push(h)
  }
  return merged
}

function redact(text, opts) {
  if (typeof text !== 'string' || !text) return { text: text ?? '', count: 0, detectors: [] }
  const hits = scan(text, opts)
  let out = ''
  let at = 0
  for (const h of hits) {
    out += text.slice(at, h.index) + `[REDACTED:${h.detector}]`
    at = h.index + h.length
  }
  out += text.slice(at)
  return { text: out, count: hits.length, detectors: [...new Set(hits.map(h => h.detector))] }
}

// Walks an object and reports which string fields hold a secret: [{ field: 'anchors[0].path', detector }].
function scanFields(obj, prefix = '') {
  const found = []
  const visit = (v, p) => {
    if (typeof v === 'string') { for (const h of scan(v)) found.push({ field: p || '(value)', detector: h.detector }) }
    else if (Array.isArray(v)) v.forEach((x, i) => visit(x, `${p}[${i}]`))
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) visit(x, p ? `${p}.${k}` : k)
  }
  visit(obj, prefix)
  return found
}

export { scan, redact, scanFields, shannon, hitsFromGitleaksRows, DETECTORS }
