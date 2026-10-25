// node --test tools/unslop/mine.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { mine, gistsFromTranscript, validSince } from './mine.mjs'

const CANARY = 'gh' + 'p_' + 'A1b2C3d4E5'.repeat(4)

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unslop-mine-'))
  const git = (...a) => { const r = spawnSync('git', a, { cwd: dir, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr) }
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false')
  const commit = (file, body, msg) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), body); git('add', '-A'); git('commit', '-qm', msg) }
  commit('src/jobs/sync.ts', 'v1\n', 'feat(jobs): batch sync queue worker')
  commit('src/jobs/sync.ts', 'v2\n', 'fix(jobs): queue retry marks the item done twice')
  commit('src/jobs/sync.ts', 'v3\n', 'fix(jobs): webhook retry runs twice after a timeout')
  commit('src/jobs/sync.ts', 'v4\n', 'fix(jobs): queue retry loses the item when the worker crashes')
  commit('README.md', 'x\n', 'docs: readme')
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

function transcript(dir) {
  const f = path.join(dir, 'session.jsonl')
  const lines = [
    { type: 'user', message: { role: 'user', content: `the retry is still running twice, token ${CANARY}` }, timestamp: '2026-10-20T10:00:00Z' },
    { type: 'user', message: { role: 'user', content: 'thanks, looks good' } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'Error: still broken' }] } },
    { type: 'user', message: { role: 'user', content: '<system-reminder>error error</system-reminder>' } },
    { type: 'assistant', message: { content: 'the bug is still there' } },
  ]
  fs.writeFileSync(f, lines.map(l => JSON.stringify(l)).join('\n') + '\nnot json\n')
  return f
}

test('clusters fix commits and bug reports by domain, measures escapes and proposes a question and a rule', () => {
  const r = repo()
  try {
    const res = mine({ repo: r.dir, since: '1.year', transcripts: [transcript(r.dir)], min: 3 })
    assert.equal(res.metrics.fixes, 3)
    assert.equal(res.metrics.feats, 1)
    assert.equal(res.metrics.lateFixRatio, 3)
    assert.equal(res.metrics.transcriptReports, 1)
    assert.ok(res.metrics.medianEscapeDays >= 0)
    const top = res.clusters[0]
    assert.equal(top.domain, 'concurrency')
    assert.ok(top.escapes >= 3)
    assert.deepEqual(top.topPaths, ['src/jobs/sync.ts'])
    assert.ok(top.proposal.question.text.includes('src/jobs/sync.ts'))
    assert.equal(top.proposal.rule.engine, 'eyes')
    assert.ok(!JSON.stringify(res).includes(CANARY))
  } finally { r.done() }
})

test('negative: transcripts keep only the human\'s complaint-like text; tool results, reminders, assistant text and junk are skipped', () => {
  const r = repo()
  try {
    const g = gistsFromTranscript(transcript(r.dir))
    assert.equal(g.length, 1)
    assert.match(g[0].gist, /retry is still running twice/)
    assert.ok(g[0].gist.length <= 200)
    assert.deepEqual(gistsFromTranscript(path.join(r.dir, 'missing.jsonl')), [])
  } finally { r.done() }
})

test('negative: below the cluster minimum, or already covered by project memory, nothing is proposed', () => {
  const r = repo()
  try {
    assert.equal(mine({ repo: r.dir, since: '1.year', min: 10 }).clusters.every(c => c.proposal === null), true)
    fs.mkdirSync(path.join(r.dir, '.jstack', 'memory', 'entries'), { recursive: true })
    const e = { id: '20261025-0000-cccccc', kind: 'failure', status: 'active', title: 'retry runs twice', domains: ['concurrency'], anchors: [{ path: 'src/jobs/sync.ts', symbol: null, commit: null }], created: '2026-10-25T00:00:00Z' }
    fs.writeFileSync(path.join(r.dir, '.jstack', 'memory', 'entries', `${e.id}.json`), JSON.stringify(e))
    const c = mine({ repo: r.dir, since: '1.year', min: 3 }).clusters.find(x => x.domain === 'concurrency')
    assert.deepEqual(c.covered, [e.id])
    assert.equal(c.proposal, null)
  } finally { r.done() }
})

test('negative: an option-shaped or odd --since is refused before it reaches git', () => {
  assert.equal(validSince('14.days'), true)
  assert.equal(validSince('2026-10-01'), true)
  for (const bad of ['--output=x', '-1', '14 days; rm', '', null]) assert.equal(validSince(bad), false, String(bad))
  assert.throws(() => mine({ repo: os.tmpdir(), since: '--output=/tmp/x' }), /--since/)
})
