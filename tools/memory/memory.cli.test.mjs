// node --test tools/memory/memory.cli.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'memory.mjs')

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jstack-mem-'))
  const g = (...a) => spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { cwd: dir, encoding: 'utf8' })
  g('init', '-q')
  fs.mkdirSync(path.join(dir, 'src', 'jobs'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'jobs', 'sync.ts'), 'export async function syncBatch(items) {\n  for (const i of items) await send(i)\n  return items.length\n}\n')
  g('add', '.'); g('commit', '-qm', 'init')
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args, '--repo', dir], { encoding: 'utf8' })
  return { dir, run, g }
}

test('init, add, query, show, retire round-trip', () => {
  const { dir, run } = setup()
  assert.equal(run('init').status, 0)
  assert.ok(fs.existsSync(path.join(dir, '.jstack', 'unslop.json')))
  const add = run('add', '--kind', 'decision', '--title', 'Batch sync records success after the send is durable', '--domain', 'concurrency', '--anchor', 'src/jobs/sync.ts#syncBatch', '--body', 'One retry owner: the queue.')
  assert.equal(add.status, 0, add.stderr)
  const id = add.stdout.trim()
  assert.match(id, /^\d{8}-\d{4}-[a-z2-7]{6}$/)
  const q = run('query', '--paths', 'src/jobs/sync.ts', '--json')
  const rows = JSON.parse(q.stdout)
  assert.equal(rows[0].entry.id, id)
  assert.equal(rows[0].anchors[0].status, 'FRESH')
  assert.equal(JSON.parse(run('show', id).stdout).anchors[0].symbol, 'syncBatch')
  assert.equal(run('retire', id, '--reason', 'replaced by the outbox').status, 0)
  assert.equal(JSON.parse(run('query', '--paths', 'src/jobs/sync.ts', '--json').stdout).length, 0)
  assert.equal(run('lint').status, 0)
})

test('negative: an entry holding a secret is refused with exit 2, and the value is never printed', () => {
  const { run } = setup()
  run('init')
  const secret = 'gh' + 'p_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
  const r = run('add', '--kind', 'failure', '--title', 'leaked token', '--body', `the token was ${secret}`)
  assert.equal(r.status, 2)
  assert.match(r.stderr, /body \(github-token\)/)
  assert.ok(!r.stderr.includes(secret) && !r.stdout.includes(secret))
})

test('negative: a malformed entry written by hand fails lint', () => {
  const { dir, run } = setup()
  run('init')
  fs.writeFileSync(path.join(dir, '.jstack', 'memory', 'entries', 'bad.json'), JSON.stringify({ id: 'nope', kind: 'idea', title: '' }))
  const r = run('lint')
  assert.equal(r.status, 1)
  assert.match(r.stdout, /kind: one of/)
  assert.match(r.stdout, /file name does not match id/)
})

test('check --changed refuses a refactor that left an anchor behind, and reanchor --auto fixes a move', () => {
  const { dir, run, g } = setup()
  run('init')
  g('add', '.'); g('commit', '-qm', 'memory')
  const id = run('add', '--kind', 'known-slop', '--title', 'Batch marked done on provider error', '--anchor', 'src/jobs/sync.ts#syncBatch').stdout.trim()
  g('add', '.'); g('commit', '-qm', 'record')
  const base = g('branch', '--show-current').stdout.trim()
  g('checkout', '-qb', 'refactor')
  g('mv', 'src/jobs/sync.ts', 'src/jobs/batch.ts'); g('commit', '-qm', 'move')
  const c = run('check', '--changed', '--base', base)
  assert.equal(c.status, 1)
  assert.match(c.stdout, /MOVED/)
  assert.equal(run('reanchor', id, '--auto').status, 0)
  assert.equal(JSON.parse(run('show', id).stdout).anchors[0].path, 'src/jobs/batch.ts')
})
