#!/usr/bin/env node
// The finding state machine of one /unslop run, and the only writer of what the report may show.
// A run lives in <repo>/.jstack/unslop/runs/<run-id>/ (gitignored): candidates.jsonl, ledger.jsonl (append-only),
// evidence/ (artifacts + <id>.evidence.json sidecars written by evidence.mjs), report.md.
//
//   CANDIDATE -> TRIAGED -> CONFIRMING -> CONFIRMED -> TEST_RED -> FIX_PROPOSED -> APPROVED -> FIXED -> VERIFIED -> RECORDED
//   TRIAGED -> SUPPRESSED (waiver | known-fp | duplicate | not-examined)     CONFIRMING -> DISMISSED | UNPROVEN
//   FIX_PROPOSED -> FIXED is allowed when the domain needs no owner approval.
// CONFIRMED needs an evidence sidecar whose latest rerun (by someone other than the producer) reproduced.
// VERIFIED needs an evidence sidecar that now passes (exit 0) on the fix.
//
//   node ledger.mjs init --repo <dir> [--run <id>]                     prints the run dir
//   node ledger.mjs add <run-dir> <candidates.jsonl>                   CANDIDATE rows for each candidate
//   node ledger.mjs move <run-dir> <finding> <STATE> --by <who> --reason "..." [--evidence evidence/x.evidence.json]
//   node ledger.mjs show <run-dir> [--json]
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { redact } from '../memory/secrets.mjs'

const NEXT = {
  CANDIDATE: ['TRIAGED', 'SUPPRESSED'],
  TRIAGED: ['CONFIRMING', 'SUPPRESSED'],
  CONFIRMING: ['CONFIRMED', 'DISMISSED', 'UNPROVEN'],
  CONFIRMED: ['TEST_RED', 'RECORDED'],
  TEST_RED: ['FIX_PROPOSED'],
  FIX_PROPOSED: ['APPROVED', 'FIXED'],
  APPROVED: ['FIXED'],
  FIXED: ['VERIFIED'],
  VERIFIED: ['RECORDED'],
  SUPPRESSED: [], DISMISSED: [], UNPROVEN: [], RECORDED: [],
}
const REPORTABLE = new Set(['CONFIRMED', 'TEST_RED', 'FIX_PROPOSED', 'APPROVED', 'FIXED', 'VERIFIED', 'RECORDED'])

class LedgerError extends Error {}

function runId(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z-' + crypto.randomBytes(2).toString('hex')
}

function initRun(repo, id = runId()) {
  const dir = path.join(repo, '.jstack', 'unslop', 'runs', id)
  fs.mkdirSync(path.join(dir, 'evidence'), { recursive: true })
  const gi = path.join(repo, '.jstack', 'unslop', '.gitignore')
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, 'runs/\n')
  for (const f of ['candidates.jsonl', 'ledger.jsonl']) if (!fs.existsSync(path.join(dir, f))) fs.writeFileSync(path.join(dir, f), '')
  return dir
}

function readJsonl(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] }
}

function rows(dir) { return readJsonl(path.join(dir, 'ledger.jsonl')) }

// Latest state per finding: Map(finding -> last row).
function states(dir) {
  const out = new Map()
  for (const r of rows(dir)) out.set(r.finding, r)
  return out
}

function readEvidence(dir, rel) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8')) } catch { return null }
}

// Does this sidecar prove the defect? The producer's run failed, and an independent rerun failed the same way.
function reproduced(ev) {
  if (!ev) return { ok: false, why: 'evidence file missing or unreadable' }
  if (ev.kind !== 'static-proof') {
    if (ev.exit === 0 && ev.kind !== 'measurement') return { ok: false, why: 'the evidence command passed; nothing failed' }
    if (ev.kind === 'measurement' && !(ev.overBudget === true)) return { ok: false, why: 'measurement is not over its budget' }
  }
  // Every kind, static proof included: only a rerun by someone other than the producer counts, and the latest wins.
  const indep = (ev.reruns ?? []).filter(r => r.by && r.by !== ev.by)
  if (!indep.length && ev.kind === 'static-proof') return { ok: false, why: 'static proof not re-checked by a second agent (no independent rerun)' }
  if (!indep.length) return { ok: false, why: 'no independent rerun (the skeptic must rerun it)' }
  const last = indep[indep.length - 1]
  return last.reproduced ? { ok: true } : { ok: false, why: `rerun by ${last.by} did not reproduce` }
}

function passes(ev) {
  if (!ev) return { ok: false, why: 'evidence file missing or unreadable' }
  if (ev.kind === 'measurement') return ev.overBudget === false ? { ok: true } : { ok: false, why: 'measurement still over budget' }
  return ev.exit === 0 ? { ok: true } : { ok: false, why: `the verify command exited ${ev.exit}` }
}

function append(dir, row) {
  const cur = states(dir).get(row.finding)
  const prev = cur?.state ?? null
  if (prev === null && row.state !== 'CANDIDATE') throw new LedgerError(`${row.finding}: unknown finding, start at CANDIDATE`)
  if (prev !== null && !NEXT[prev]?.includes(row.state)) throw new LedgerError(`${row.finding}: ${prev} -> ${row.state} is not allowed (next: ${NEXT[prev].join(', ') || 'none, terminal'})`)
  if (!row.by) throw new LedgerError(`${row.finding}: every move names who made it (--by)`)
  const evidence = row.evidence ?? []
  if (row.state === 'CONFIRMED') {
    if (!evidence.length) throw new LedgerError(`${row.finding}: CONFIRMED needs evidence`)
    const bad = evidence.map(e => reproduced(readEvidence(dir, e))).find(x => !x.ok)
    if (bad) throw new LedgerError(`${row.finding}: CONFIRMED refused: ${bad.why}`)
  }
  if (row.state === 'TEST_RED') {
    if (!evidence.length) throw new LedgerError(`${row.finding}: TEST_RED needs the failing test's evidence`)
    const ev = readEvidence(dir, evidence[0])
    if (!ev || ev.exit === 0) throw new LedgerError(`${row.finding}: TEST_RED refused: the test does not fail on HEAD`)
  }
  if (row.state === 'VERIFIED') {
    if (!evidence.length) throw new LedgerError(`${row.finding}: VERIFIED needs the re-test evidence`)
    const bad = evidence.map(e => passes(readEvidence(dir, e))).find(x => !x.ok)
    if (bad) throw new LedgerError(`${row.finding}: VERIFIED refused: ${bad.why}`)
  }
  if (['DISMISSED', 'SUPPRESSED', 'UNPROVEN'].includes(row.state) && !row.reason) throw new LedgerError(`${row.finding}: ${row.state} needs a reason`)
  const out = { ...row, reason: row.reason ? redact(String(row.reason)).text.slice(0, 500) : null, evidence, prev, at: row.at ?? new Date().toISOString() }
  fs.appendFileSync(path.join(dir, 'ledger.jsonl'), JSON.stringify(out) + '\n')
  return out
}

function addCandidates(dir, candidates, by = 'scan') {
  const known = new Set(readJsonl(path.join(dir, 'candidates.jsonl')).map(c => c.id))
  const st = states(dir)
  let n = 0
  for (const c of candidates) {
    if (!known.has(c.id)) fs.appendFileSync(path.join(dir, 'candidates.jsonl'), JSON.stringify(c) + '\n')
    const finding = 'f-' + c.id.replace(/^c-/, '')
    if (st.has(finding)) continue
    append(dir, { finding, candidate: c.id, state: 'CANDIDATE', by: c.source ?? by })
    n++
  }
  return n
}

function summary(dir) {
  const st = states(dir)
  const counts = {}
  for (const r of st.values()) counts[r.state] = (counts[r.state] ?? 0) + 1
  return { counts, findings: [...st.values()] }
}

function main(argv) {
  const [cmd, ...rest] = argv
  const get = k => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined }
  try {
    if (cmd === 'init') { console.log(initRun(path.resolve(get('--repo') ?? '.'), get('--run') ?? runId())); return 0 }
    if (cmd === 'add') {
      const [dir, file] = rest
      const n = addCandidates(dir, readJsonl(file))
      console.log(`${n} candidate(s) added`)
      return 0
    }
    if (cmd === 'move') {
      const [dir, finding, state] = rest
      const ev = []
      rest.forEach((a, i) => { if (a === '--evidence') ev.push(rest[i + 1]) })
      const r = append(dir, { finding, state, by: get('--by'), reason: get('--reason'), evidence: ev })
      console.log(`${r.finding}: ${r.prev} -> ${r.state}`)
      return 0
    }
    if (cmd === 'show') {
      const s = summary(rest[0])
      if (rest.includes('--json')) console.log(JSON.stringify(s, null, 2))
      else {
        for (const f of s.findings) console.log(`${f.finding.padEnd(10)} ${f.state.padEnd(13)} ${f.by ?? ''}  ${f.reason ?? ''}`)
        console.log(Object.entries(s.counts).map(([k, v]) => `${k} ${v}`).join(', ') || 'empty')
      }
      return 0
    }
    console.log('usage: ledger.mjs init|add|move|show (see the header of this file)')
    return 2
  } catch (e) {
    if (e instanceof LedgerError) { console.error(`refused: ${e.message}`); return 2 }
    throw e
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)))

export { initRun, append, addCandidates, states, rows, summary, reproduced, passes, readEvidence, runId, LedgerError, NEXT, REPORTABLE }
