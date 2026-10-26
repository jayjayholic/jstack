import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
process.env.JSTACK_PERF_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-opt-'))
const DIR = process.env.JSTACK_PERF_DIR
const { firstSnap, tickHealth } = await import('./lib.mjs')
const { aliveSummary, startOptimizer, finishOptimizer, releaseOptimizer, optState, optimizerDue } = await import('./ops.mjs')
const { childEnv, promptFrom, parseFinal, headlessDue, parseResult, optimizerConfig } = await import('./optimizer-run.mjs')
const { taskXml } = await import('./perf.mjs')

const O = optimizerConfig({}, DIR)

// ---------- snapshot retry ----------

test('firstSnap: the full snap wins when it works, the light retry is not run', async () => {
  let ran = 0
  const r = await firstSnap([async () => 'full', async () => { ran++; return 'light' }], () => assert.fail('no failure'))
  assert.deepEqual(r, { snap: 'full', attempt: 0 })
  assert.equal(ran, 0)
})

test('firstSnap: a killed full snap falls back to the light one and reports the failure', async () => {
  const fails = []
  const r = await firstSnap([async () => { throw new Error('perf-snap killed after 30 s (timeout)') }, async () => 'light'], (i, e) => fails.push([i, e.message]))
  assert.deepEqual(r, { snap: 'light', attempt: 1 })
  assert.deepEqual(fails, [[0, 'perf-snap killed after 30 s (timeout)']])
})

test('firstSnap: when every attempt fails the last error is thrown (the tick is lost and logged)', async () => {
  await assert.rejects(firstSnap([async () => { throw new Error('a') }, async () => { throw new Error('b') }]), /b/)
  await assert.rejects(firstSnap([]), /no snapshot attempt/)
})

test('tickHealth counts lost and retry-saved ticks inside the window only', () => {
  const log = [
    '2026-10-25T01:00:00.000Z tick: Error: perf-snap exited null: ',
    '    at ChildProcess.<anonymous> (file:///x/collect.mjs:55:37)',
    '2026-10-26T01:00:00.000Z tick: Error: perf-snap exited 1: OutOfMemoryException',
    '2026-10-26T02:00:00.000Z snap: full snap failed: perf-snap killed after 30 s (timeout); retrying light',
    '2026-10-26T02:00:01.000Z snap: light retry ok, tick kept (31200 ms)',
    '2026-10-26T03:00:00.000Z collector start pid 1 every 60s',
  ].join('\n')
  assert.deepEqual(tickHealth(log, Date.parse('2026-10-25T12:00:00Z')), { lost: 1, recovered: 1, lastLostAt: '2026-10-26T01:00:00.000Z' })
  assert.deepEqual(tickHealth('', 0), { lost: 0, recovered: 0, lastLostAt: null })
})

// ---------- the headless runner ----------

const PERF_MD = fs.readFileSync(path.join(HERE, '..', '..', 'skills', 'machine-memory', 'PERF.md'), 'utf8')

test('promptFrom: the real PERF.md prompt with the installed perf.mjs, the lock note and the cap', () => {
  const p = promptFrom(PERF_MD, { appDir: 'C:\\Users\\u\\.jstack\\perf\\app', perfMdPath: 'C:\\Users\\u\\.jstack\\perf\\app\\PERF.md', pending: [{ type: 'ram-low' }], capMin: 25, repo: 'C:\\dev\\jstack' })
  assert.match(p, /`node C:\/Users\/u\/\.jstack\/perf\/app\/perf\/perf\.mjs floor --write`/)
  assert.match(p, /`node C:\/Users\/u\/\.jstack\/perf\/app\/perf\/perf\.mjs optimizer finish --summary/)
  assert.doesNotMatch(p, /\$P\b|P="/)
  assert.match(p, /PERF\.md \(C:\/Users\/u\/\.jstack\/perf\/app\/PERF\.md\) sections/)
  assert.match(p, /already ran `optimizer start`.*"ram-low"/)
  assert.doesNotMatch(p, /\{\{JSTACK_TOOLS\}\}/)
  assert.doesNotMatch(p, /if it says started:false, stop/)
  assert.match(p, /Hard cap: 25 minutes/)
  assert.match(p, /optimizer finish --summary/)
})

test('promptFrom: no prompt block in section 7 is an error, CRLF files still parse', () => {
  assert.throws(() => promptFrom('# x\n## 7. nothing here', { appDir: 'a', perfMdPath: 'b', capMin: 1 }), /no prompt block/)
  assert.match(promptFrom(PERF_MD.replace(/\n/g, '\r\n'), { appDir: 'a', perfMdPath: 'b', capMin: 1 }), /optimizer finish/)
})

test('parseFinal: first line is the summary, the rest are proposals; empty text gives nothing', () => {
  assert.deepEqual(parseFinal('looked at tsc: at-floor\n- move WSL to 6 GB (needs the human)\n\n2. close brave tabs'), { summary: 'looked at tsc: at-floor', proposals: ['move WSL to 6 GB (needs the human)', 'close brave tabs'] })
  assert.deepEqual(parseFinal(''), { summary: '', proposals: [] })
  assert.deepEqual(parseFinal(undefined), { summary: '', proposals: [] })
})

test('childEnv: no API key or token reaches the run, its own config folder does', () => {
  const env = childEnv({ PATH: 'p', ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', CLAUDE_CODE_OAUTH_TOKEN: 'o', CLAUDECODE: '1', CLAUDE_CONFIG_DIR: 'C:\\Users\\u\\.claude' }, 'C:\\own', 'C:\\store')
  assert.deepEqual(env, { PATH: 'p', CLAUDE_CONFIG_DIR: 'C:\\own', JSTACK_PERF_DIR: 'C:\\store' })
})

test('parseResult reads claude -p json; garbage is an error, never a summary', () => {
  assert.deepEqual(parseResult('{"type":"result","subtype":"success","is_error":false,"result":"done","total_cost_usd":0.12,"num_turns":9}\n'), { text: 'done', isError: false, costUsd: 0.12, turns: 9, stop: 'success' })
  assert.equal(parseResult('Error: not logged in').isError, true)
  assert.equal(parseResult('').text, '')
})

test('headlessDue: a failed start backs off, then the normal due rule applies', () => {
  const now = Date.parse('2026-10-26T07:00:00Z')
  const due = { due: true, reason: 'never ran' }
  assert.equal(headlessDue(now, O, { lastFailedAt: '2026-10-26T06:50:00Z', lastFailure: 'no account' }, due).due, false)
  assert.equal(headlessDue(now, O, { lastFailedAt: '2026-10-26T06:00:00Z' }, due).due, true)
  assert.equal(headlessDue(now, O, {}, { due: false, reason: 'x' }).due, false)
})

test('optimizer lock: one run at a time; release does not count as a run, finish does', () => {
  const now = Date.now()
  assert.equal(startOptimizer({ now, by: 'headless' }).started, true)
  assert.equal(startOptimizer({ now }).started, false)
  releaseOptimizer()
  assert.equal(optState().runningSince, undefined)
  assert.equal(optState().lastFinishedAt, undefined)
  assert.equal(startOptimizer({ now }).started, true)
  finishOptimizer('looked at tsc', { by: 'headless', minutes: 3 }, now)
  assert.equal(optState().runningSince, undefined)
  assert.equal(optState().lastSummary, 'looked at tsc')
  const act = fs.readFileSync(path.join(DIR, 'actions.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).pop()
  assert.equal(act.action, 'optimizer-run')
  assert.equal(act.minutes, 3)
  assert.equal(optimizerDue(now + 60000).due, false)
})

test('aliveSummary: running, backing off, due now, and next due time', () => {
  const now = Date.parse('2026-10-26T07:00:00Z')
  const health = { lost: 2, recovered: 5, lastLostAt: null }
  const base = { now, lastTickSec: 20, health, o: O }
  const notDue = { due: false, reason: '' }
  assert.match(aliveSummary({ ...base, opt: { runningSince: '2026-10-26T06:55:00Z' }, due: notDue }).line, /next due running since 06:55Z/)
  assert.match(aliveSummary({ ...base, opt: { lastFailedAt: '2026-10-26T06:50:00Z', lastFailure: 'no account' }, due: notDue }).line, /next due 07:20Z \(backing off/)
  assert.match(aliveSummary({ ...base, opt: { lastFinishedAt: '2026-10-26T06:00:00Z', lastSummary: 's' }, due: { due: true, reason: 'last run 60 min ago' } }).line, /next due now, last run 60 min ago/)
  const s = aliveSummary({ ...base, opt: { lastFinishedAt: '2026-10-26T06:45:00Z', lastSummary: 'tsc at-floor' }, due: notDue })
  assert.equal(s.line, 'last tick 20s ago | failed ticks 24h: 2 lost, 5 saved by retry | optimizer last run 06:45Z "tsc at-floor" | next due 07:15Z')
  assert.match(aliveSummary({ ...base, lastTickSec: null, opt: {}, due: notDue }).line, /^collector NOT running .* last run never/)
})

test('optimizer task XML: no logon trigger, every 5 min, battery-safe, its own time limit', () => {
  const xml = taskXml({ launcher: 'C:\\x\\optimizer.vbs', intervalMin: 5, atLogon: false, limitMin: 35, description: 'opt & co' })
  assert.doesNotMatch(xml, /LogonTrigger/)
  assert.match(xml, /<Interval>PT5M</)
  assert.match(xml, /<ExecutionTimeLimit>PT35M</)
  assert.match(xml, /<DisallowStartIfOnBatteries>false</)
  assert.match(xml, /<RunLevel>LeastPrivilege</)
  assert.match(xml, /opt &amp; co/)
  assert.match(taskXml({ launcher: 'x', intervalMin: 5 }), /LogonTrigger/)
})
