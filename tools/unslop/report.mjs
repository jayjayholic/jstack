#!/usr/bin/env node
// Renders the human report of an /unslop run from the ledger. Only findings in CONFIRMED or a later state reach the
// body, and each must still carry evidence that reproduced (the report re-checks the sidecars and refuses a row
// whose evidence is missing or whose rerun failed). DISMISSED, UNPROVEN, SUPPRESSED and not-examined candidates
// appear only as counts and one-line reasons in the footer, so the human never reads a hypothesis as a finding.
//   node report.mjs <run-dir> [--out report.md] [--cost-usd 1.23] [--minutes 14]
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { states, readEvidence, reproduced, passes, REPORTABLE } from './ledger.mjs'
import { redact } from '../memory/secrets.mjs'

function readJsonl(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] }
}

function history(dir, finding) {
  return readJsonl(path.join(dir, 'ledger.jsonl')).filter(r => r.finding === finding)
}

function tail(dir, rel, n = 12) {
  try { return fs.readFileSync(path.join(dir, rel), 'utf8').replace(/\r/g, '').split('\n').filter(Boolean).slice(-n).join('\n') } catch { return '' }
}

function buildReport(dir, { costUsd = null, minutes = null } = {}) {
  const cands = new Map(readJsonl(path.join(dir, 'candidates.jsonl')).map(c => [c.id, c]))
  const st = states(dir)
  const body = [], refused = [], footer = { DISMISSED: [], UNPROVEN: [], SUPPRESSED: [], open: 0 }
  for (const [finding, last] of st) {
    const rowsFor = history(dir, finding)
    const cand = cands.get(rowsFor[0]?.candidate) ?? {}
    if (!REPORTABLE.has(last.state)) {
      if (footer[last.state]) footer[last.state].push({ finding, rule: cand.rule, reason: last.reason })
      else footer.open++
      continue
    }
    const confirmRow = rowsFor.find(r => r.state === 'CONFIRMED')
    const evs = (confirmRow?.evidence ?? []).map(e => ({ rel: e, ev: readEvidence(dir, e) }))
    const bad = evs.length ? evs.map(x => reproduced(x.ev)).find(x => !x.ok) : { why: 'no evidence' }
    if (bad) { refused.push({ finding, rule: cand.rule, why: bad.why }); continue }
    const verifyRow = rowsFor.find(r => r.state === 'VERIFIED')
    const after = verifyRow ? (verifyRow.evidence ?? []).map(e => ({ rel: e, ev: readEvidence(dir, e) })) : []
    const lines = [
      `### ${cand.title ?? cand.rule ?? finding}  (${last.state})`,
      '',
      `- **Where:** \`${cand.path ?? '?'}:${cand.line ?? '?'}\`${cand.symbol ? ` in \`${cand.symbol}\`` : ''}  **Domain:** ${cand.domain ?? '?'}  **Severity:** ${cand.severity ?? '?'}  **Rule:** ${cand.rule ?? 'novel'}`,
      `- **Scenario:** ${cand.scenario ?? '-'}`,
    ]
    for (const { rel, ev } of evs) {
      lines.push(`- **Evidence (${ev.kind}):** \`${ev.cmd}\` exit ${ev.exit} on ${ev.sha}${ev.dirty ? ' (dirty)' : ''}${ev.assertion ? ` - "${ev.assertion}"` : ''}; rerun by ${ev.reruns.at(-1)?.by} reproduced. Artifact: \`${rel}\``)
      const t = tail(dir, ev.output, 8)
      if (t) lines.push('', '```', redact(t).text, '```')
    }
    if (cand.fixHint) lines.push(`- **Fix direction:** ${cand.fixHint}`)
    for (const { rel, ev } of after) lines.push(`- **After the fix:** \`${ev?.cmd}\` exit ${ev?.exit} (${passes(ev).ok ? 'passes' : 'STILL FAILING'}). Artifact: \`${rel}\``)
    body.push(lines.join('\n'))
  }
  const counts = {}
  for (const r of st.values()) counts[r.state] = (counts[r.state] ?? 0) + 1
  const out = [
    `# /unslop report: ${path.basename(dir)}`,
    '',
    `${body.length} confirmed finding(s), each with evidence a second agent reproduced.${costUsd != null ? ` Cost $${costUsd}.` : ''}${minutes != null ? ` ${minutes} min.` : ''}`,
    '',
    ...(body.length ? body : ['No confirmed findings.']),
    '',
    '## Footer (not findings)',
    '',
    `States: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}.`,
    ...footer.DISMISSED.map(d => `- dismissed ${d.rule ?? d.finding}: ${d.reason}`),
    ...footer.UNPROVEN.map(d => `- unproven ${d.rule ?? d.finding}: ${d.reason}`),
    ...footer.SUPPRESSED.map(d => `- suppressed ${d.rule ?? d.finding}: ${d.reason}`),
    ...(footer.open ? [`- ${footer.open} candidate(s) not examined (left before confirm; never silent)`] : []),
    ...refused.map(r => `- REFUSED in the report ${r.rule ?? r.finding}: ${r.why}`),
  ]
  return { markdown: out.join('\n') + '\n', shown: body.length, refused, counts }
}

function main(argv) {
  const [dir] = argv
  const get = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }
  const r = buildReport(dir, { costUsd: get('--cost-usd') ?? null, minutes: get('--minutes') ?? null })
  const out = get('--out') ?? path.join(dir, 'report.md')
  fs.writeFileSync(out, r.markdown)
  console.log(`${out}: ${r.shown} finding(s)${r.refused.length ? `, ${r.refused.length} refused for weak evidence` : ''}`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)))

export { buildReport }
