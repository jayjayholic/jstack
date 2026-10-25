// node --test tools/unslop/desk.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { recommend, suggest } from './desk.mjs'

const base = { base: 'origin/main', mergeBase: 'abc1234', ahead: 3, dirty: 0, commits: 40, recent: { n: 5, base: 'def5678' }, pr: null, tracked: 900 }

test('recommends this branch when it has its own work, and never full by default', () => {
  const r = recommend(base)
  assert.equal(r.recommended, 'branch')
  assert.deepEqual(r.options.map(o => o.id), ['branch', 'recent', 'full'])
  assert.equal(recommend({ ...base, pr: { number: 7, base: 'origin/stage' } }).recommended, 'pr')
})

test('negative: a clean base branch falls back to recent commits, not to the full project', () => {
  const r = recommend({ ...base, ahead: 0, dirty: 0 })
  assert.equal(r.recommended, 'recent')
  assert.ok(!r.options.some(o => o.id === 'branch'))
})

test('negative: with no base and a single commit, only full is left and it says so', () => {
  const r = recommend({ ...base, mergeBase: null, ahead: null, recent: null })
  assert.equal(r.recommended, 'full')
  assert.match(r.why, /nothing smaller/)
})

test('suggest on a real repo: counts the branch diff and its static hits; gh missing means no PR option', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unslop-desk-'))
  const git = (...a) => { const r = spawnSync('git', a, { cwd: dir, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr) }
  try {
    git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false')
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1\n'); git('add', '-A'); git('commit', '-qm', 'base')
    git('checkout', '-q', '-b', 'feature')
    fs.mkdirSync(path.join(dir, 'src', 'jobs'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'src', 'jobs', 'sync.ts'), 'async function run(x) {\n  try { await x() } catch {}\n}\nexport { run }\n'); git('add', '-A'); git('commit', '-qm', 'slop')
    const s = suggest(dir, { base: 'main', gh: () => null })
    assert.equal(s.recommended, 'branch')
    const b = s.options.find(o => o.id === 'branch')
    assert.equal(b.estimate.staticHits, 1)
    assert.ok(b.estimate.domains.includes('concurrency'))
    assert.ok(!s.options.some(o => o.id === 'pr'))
    assert.match(s.options.find(o => o.id === 'full').estimate.note, /not pre-scanned/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
