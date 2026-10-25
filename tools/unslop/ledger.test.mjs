import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initRun, append, addCandidates, states, LedgerError } from './ledger.mjs'
import { runEvidence, rerunEvidence } from './evidence.mjs'
import { buildReport } from './report.mjs'

const CANARY = 'sk-ant-api03-' + 'Zx9'.repeat(12)

function setup() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'unslop-ledger-'))
  const dir = initRun(repo, 'run-1')
  const script = (name, body) => { const f = path.join(repo, name); fs.writeFileSync(f, body); return `node "${f}"` }
  const failing = script('fail.mjs', `console.log('token ${CANARY}'); console.error('AssertionError: expected status FAILED, received DONE'); process.exit(1)\n`)
  const passing = script('pass.mjs', `console.log('ok'); process.exit(0)\n`)
  addCandidates(dir, [{ id: 'c-aa11', source: 'static', rule: 'conc.empty-catch', domain: 'concurrency', title: 'Swallowed error', path: 'src/jobs/sync.ts', line: 4, severity: 'high', scenario: 'provider throws -> batch marked done', fixHint: 'rethrow' }])
  return { repo, dir, failing, passing, done: () => fs.rmSync(repo, { recursive: true, force: true }) }
}

test('full legal path to RECORDED, with evidence produced by one agent and reproduced by another', () => {
  const s = setup()
  try {
    const f = 'f-aa11'
    append(s.dir, { finding: f, state: 'TRIAGED', by: 'orchestrator' })
    append(s.dir, { finding: f, state: 'CONFIRMING', by: 'orchestrator' })
    const ev = runEvidence(s.dir, { id: 'f-aa11.test', kind: 'failing-test', by: 'prosecutor#1', cmd: s.failing, cwd: s.repo })
    assert.equal(ev.exit, 1)
    assert.match(ev.assertion, /expected status FAILED/)
    assert.ok(ev.sha === null || typeof ev.sha === 'string')
    assert.equal(ev.outputRedactions, 1)
    assert.ok(!fs.readFileSync(path.join(s.dir, ev.output), 'utf8').includes(CANARY), 'canary secret leaked into the evidence log')
    assert.equal(rerunEvidence(s.dir, { id: 'f-aa11.test', by: 'skeptic#2', cwd: s.repo }).reproduced, true)
    append(s.dir, { finding: f, state: 'CONFIRMED', by: 'skeptic#2', evidence: ['evidence/f-aa11.test.evidence.json'] })
    append(s.dir, { finding: f, state: 'TEST_RED', by: 'fixer', evidence: ['evidence/f-aa11.test.evidence.json'] })
    append(s.dir, { finding: f, state: 'FIX_PROPOSED', by: 'fixer' })
    append(s.dir, { finding: f, state: 'FIXED', by: 'fixer' })
    runEvidence(s.dir, { id: 'f-aa11.after', kind: 'failing-test', by: 'fixer', cmd: s.passing, cwd: s.repo })
    append(s.dir, { finding: f, state: 'VERIFIED', by: 'skeptic#2', evidence: ['evidence/f-aa11.after.evidence.json'] })
    append(s.dir, { finding: f, state: 'RECORDED', by: 'orchestrator' })
    assert.equal(states(s.dir).get(f).state, 'RECORDED')
    const r = buildReport(s.dir)
    assert.equal(r.shown, 1)
    assert.match(r.markdown, /src\/jobs\/sync\.ts:4/)
    assert.match(r.markdown, /After the fix/)
    assert.ok(!r.markdown.includes(CANARY))
  } finally { s.done() }
})

test('negative: CONFIRMED without evidence, or without an independent rerun, is refused', () => {
  const s = setup()
  try {
    const f = 'f-aa11'
    append(s.dir, { finding: f, state: 'TRIAGED', by: 'o' })
    append(s.dir, { finding: f, state: 'CONFIRMING', by: 'o' })
    assert.throws(() => append(s.dir, { finding: f, state: 'CONFIRMED', by: 'skeptic' }), LedgerError)
    runEvidence(s.dir, { id: 'e1', kind: 'failing-test', by: 'prosecutor', cmd: s.failing, cwd: s.repo })
    assert.throws(() => append(s.dir, { finding: f, state: 'CONFIRMED', by: 'prosecutor', evidence: ['evidence/e1.evidence.json'] }), /independent rerun/)
    rerunEvidence(s.dir, { id: 'e1', by: 'prosecutor', cwd: s.repo })
    assert.throws(() => append(s.dir, { finding: f, state: 'CONFIRMED', by: 'prosecutor', evidence: ['evidence/e1.evidence.json'] }), /independent rerun/)
  } finally { s.done() }
})

test('negative: VERIFIED without a passing re-test is refused, and illegal jumps are refused', () => {
  const s = setup()
  try {
    const f = 'f-aa11'
    assert.throws(() => append(s.dir, { finding: f, state: 'FIXED', by: 'x' }), /not allowed/)
    append(s.dir, { finding: f, state: 'TRIAGED', by: 'o' })
    append(s.dir, { finding: f, state: 'CONFIRMING', by: 'o' })
    runEvidence(s.dir, { id: 'e1', kind: 'failing-test', by: 'p', cmd: s.failing, cwd: s.repo })
    rerunEvidence(s.dir, { id: 'e1', by: 'k', cwd: s.repo })
    append(s.dir, { finding: f, state: 'CONFIRMED', by: 'k', evidence: ['evidence/e1.evidence.json'] })
    append(s.dir, { finding: f, state: 'TEST_RED', by: 'fixer', evidence: ['evidence/e1.evidence.json'] })
    append(s.dir, { finding: f, state: 'FIX_PROPOSED', by: 'fixer' })
    append(s.dir, { finding: f, state: 'FIXED', by: 'fixer' })
    assert.throws(() => append(s.dir, { finding: f, state: 'VERIFIED', by: 'k', evidence: ['evidence/e1.evidence.json'] }), /exited 1/)
  } finally { s.done() }
})

test('negative: DISMISSED and UNPROVEN never reach the report body; a row whose rerun failed is refused', () => {
  const s = setup()
  try {
    addCandidates(s.dir, [{ id: 'c-bb22', rule: 'perf.transition-all', path: 'a.css', line: 1 }, { id: 'c-cc33', rule: 'ix.vh-shell', path: 'b.css', line: 2 }])
    for (const f of ['f-aa11', 'f-bb22', 'f-cc33']) { append(s.dir, { finding: f, state: 'TRIAGED', by: 'o' }); append(s.dir, { finding: f, state: 'CONFIRMING', by: 'o' }) }
    append(s.dir, { finding: 'f-bb22', state: 'DISMISSED', by: 'skeptic', reason: 'guarded upstream at src/x.ts:12' })
    append(s.dir, { finding: 'f-cc33', state: 'UNPROVEN', by: 'prosecutor', reason: 'needs a phone' })
    runEvidence(s.dir, { id: 'e1', kind: 'failing-test', by: 'p', cmd: s.failing, cwd: s.repo })
    rerunEvidence(s.dir, { id: 'e1', by: 'k', cwd: s.repo })
    append(s.dir, { finding: 'f-aa11', state: 'CONFIRMED', by: 'k', evidence: ['evidence/e1.evidence.json'] })
    const side = path.join(s.dir, 'evidence', 'e1.evidence.json')
    const j = JSON.parse(fs.readFileSync(side, 'utf8'))
    j.reruns.push({ by: 'k2', reproduced: false })
    fs.writeFileSync(side, JSON.stringify(j))
    const r = buildReport(s.dir)
    assert.equal(r.shown, 0)
    assert.match(r.markdown, /REFUSED in the report conc\.empty-catch: rerun by k2 did not reproduce/)
    assert.match(r.markdown, /dismissed perf\.transition-all: guarded upstream/)
    assert.match(r.markdown, /unproven ix\.vh-shell: needs a phone/)
    assert.ok(!/### .*a\.css/.test(r.markdown))
  } finally { s.done() }
})

test('negative: dismissing without a reason is refused', () => {
  const s = setup()
  try {
    append(s.dir, { finding: 'f-aa11', state: 'TRIAGED', by: 'o' })
    append(s.dir, { finding: 'f-aa11', state: 'CONFIRMING', by: 'o' })
    assert.throws(() => append(s.dir, { finding: 'f-aa11', state: 'DISMISSED', by: 'k' }), /needs a reason/)
  } finally { s.done() }
})
