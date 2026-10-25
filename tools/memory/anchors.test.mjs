// node --test tools/memory/anchors.test.mjs   (builds throwaway git repos in the temp folder)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { makeAnchor, resolveAnchor } from './anchors.mjs'

const SYNC = [
  'export async function syncBatch(items, provider, store) {',
  '  for (const item of items) {',
  '    const result = await provider.send(item.payload, { timeout: 30000 })',
  '    if (!result.ok) throw new Error(`send failed for ${item.id}`)',
  '    await store.markDone(item.id, result.receipt)',
  '    await store.audit("sent", item.id, result.receipt.at)',
  '  }',
  '  return items.length',
  '}',
  '',
].join('\n')

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jstack-anchor-'))
  const g = (...a) => { const r = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { cwd: dir, encoding: 'utf8' }); if (r.status) throw new Error(r.stderr); return r.stdout.trim() }
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text) }
  g('init', '-q')
  write('src/jobs/sync.ts', SYNC + 'export function other() {\n  return 42\n}\n')
  g('add', '.'); g('commit', '-qm', 'init')
  const commit = (msg) => { g('add', '-A'); g('commit', '-qm', msg) }
  return { dir, g, write, commit }
}

test('FRESH when nothing changed; DRIFTED when the body changed; formatting-only stays FRESH', () => {
  const r = repo()
  const a = makeAnchor(r.dir, 'src/jobs/sync.ts#syncBatch')
  assert.equal(resolveAnchor(r.dir, a).status, 'FRESH')
  r.write('src/jobs/sync.ts', SYNC.replace('return items.length', 'return  items.length ;') + 'export function other() {\n  return 42\n}\n')
  assert.equal(resolveAnchor(r.dir, a).status, 'FRESH')
  r.write('src/jobs/sync.ts', SYNC.replace('return items.length', 'return 0') + 'export function other() {\n  return 42\n}\n')
  assert.equal(resolveAnchor(r.dir, a).status, 'DRIFTED')
})

test('MOVED via git mv is found and safe to re-anchor automatically', () => {
  const r = repo()
  const a = makeAnchor(r.dir, 'src/jobs/sync.ts#syncBatch')
  fs.mkdirSync(path.join(r.dir, 'src', 'queue'))
  r.g('mv', 'src/jobs/sync.ts', 'src/queue/sync-batch.ts')
  r.commit('move')
  const res = resolveAnchor(r.dir, a)
  assert.equal(res.status, 'MOVED')
  assert.equal(res.path, 'src/queue/sync-batch.ts')
  assert.equal(res.auto, true)
})

test('RENAMED symbol is found by body similarity', () => {
  const r = repo()
  const a = makeAnchor(r.dir, 'src/jobs/sync.ts#syncBatch')
  r.write('src/jobs/sync.ts', SYNC.replace('syncBatch', 'deliverBatch') + 'export function other() {\n  return 42\n}\n')
  r.commit('rename')
  const res = resolveAnchor(r.dir, a)
  assert.equal(res.status, 'RENAMED')
  assert.equal(res.symbol, 'deliverBatch')
  assert.equal(res.auto, true)
})

test('SPLIT into two functions is reported with both parts', () => {
  const r = repo()
  const a = makeAnchor(r.dir, 'src/jobs/sync.ts#syncBatch')
  r.g('rm', '-q', 'src/jobs/sync.ts')
  r.write('src/jobs/fetch.ts', [
    'export async function sendAll(items, provider) {',
    '  for (const item of items) {',
    '    const result = await provider.send(item.payload, { timeout: 30000 })',
    '    if (!result.ok) throw new Error(`send failed for ${item.id}`)',
    '  }',
    '}',
    '',
  ].join('\n'))
  r.write('src/jobs/commit.ts', [
    'export async function recordAll(items, store, result) {',
    '  for (const item of items) {',
    '    await store.markDone(item.id, result.receipt)',
    '    await store.audit("sent", item.id, result.receipt.at)',
    '  }',
    '  return items.length',
    '}',
    '',
  ].join('\n'))
  r.commit('refactor(jobs): split sync into fetch + commit')
  const res = resolveAnchor(r.dir, a)
  assert.equal(res.status, 'SPLIT')
  assert.deepEqual(res.parts.map(p => p.symbol).sort(), ['recordAll', 'sendAll'])
  assert.equal(res.auto, false)
})

test('negative: deleted code is STALE and names the removing commit', () => {
  const r = repo()
  const a = makeAnchor(r.dir, 'src/jobs/sync.ts#syncBatch')
  r.write('src/jobs/sync.ts', 'export function other() {\n  return 42\n}\n')
  r.commit('chore: drop batch sync')
  const res = resolveAnchor(r.dir, a)
  assert.equal(res.status, 'STALE')
  assert.match(res.removedIn, /drop batch sync/)
  assert.match(res.suggestion, /retire/)
})

test('negative: an ambiguous rename (two equal matches) is not re-anchored automatically', () => {
  const r = repo()
  const a = makeAnchor(r.dir, 'src/jobs/sync.ts#syncBatch')
  r.g('rm', '-q', 'src/jobs/sync.ts')
  r.write('src/a/one.ts', SYNC.replace('syncBatch', 'batchA'))
  r.write('src/b/two.ts', SYNC.replace('syncBatch', 'batchB'))
  r.commit('duplicate it')
  const res = resolveAnchor(r.dir, a)
  assert.equal(res.status, 'STALE')
  assert.equal(res.auto, false)
  assert.match(res.detail, /ambiguous/)
  assert.equal(res.candidates.length >= 2, true)
})
