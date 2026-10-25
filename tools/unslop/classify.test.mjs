import test from 'node:test'
import assert from 'node:assert/strict'
import { classify } from './classify.mjs'

const names = r => r.domains.map(d => d.domain).sort()

test('a task about a retry queue picks concurrency, with eval-testing as its companion', () => {
  const r = classify({ task: 'Add a retry queue for failed webhook deliveries', paths: ['src/jobs/deliver.ts'] })
  assert.ok(names(r).includes('concurrency'))
  assert.ok(names(r).includes('eval-testing'))
  assert.match(r.domains.find(d => d.domain === 'concurrency').reasons.join(' '), /retry/)
})

test('negative: a README typo picks no domain and tiers S', () => {
  const r = classify({ task: 'Fix a typo in the README', paths: ['README.md'] })
  assert.deepEqual(names(r), [])
  assert.equal(r.tierHint.tier, 'S')
})

test('negative: a path-only match inside an ignored folder picks nothing', () => {
  const r = classify({ task: 'bump the vendored copy', paths: ['vendor/queue/jobs/x.ts', 'node_modules/a/jobs/b.js'] })
  assert.deepEqual(names(r), [])
  assert.deepEqual(r.paths, [])
})

test('negative: a single weak word is listed as weak, not chosen', () => {
  const r = classify({ task: 'make the label shorter' })
  assert.equal(r.domains.length, 0)
  assert.ok(r.weak.some(w => w.domain === 'copy'))
})

test('irreversible or security words never tier S', () => {
  const r = classify({ task: 'add a migration for the session table', paths: ['db/migrations/1/migration.sql'] })
  assert.notEqual(r.tierHint.tier, 'S')
  assert.ok(names(r).includes('data-privacy'))
})

test('a bug report in symptom words reaches its pack, with agent-discipline as a companion', () => {
  const r = classify({ task: 'The context menu opens far from the pointer once the sidebar scrolls' })
  assert.ok(names(r).includes('interaction'))
  assert.ok(names(r).includes('agent-discipline'))
  assert.match(r.domains.find(d => d.domain === 'agent-discipline').reasons.join(' '), /quoted ask/)
})

test('negative: companions are not added when no pack is chosen', () => {
  const r = classify({ task: 'bump the version number' })
  assert.deepEqual(names(r), [])
})
