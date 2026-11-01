// node --test tools/cloud/orphans.test.mjs
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { checkBranch, rescue, scan, workBranchFor } from './orphans.mjs'

const ENV = { JSTACK_INTEGRATION_BRANCH: 'main' }
let root, repo

function sh(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}
function commit(file, text) {
  fs.writeFileSync(path.join(repo, file), text)
  sh(repo, 'add', file)
  sh(repo, 'commit', '-q', '-m', `edit ${file}`)
  return sh(repo, 'rev-parse', 'HEAD')
}
function publish(...branches) {
  sh(repo, 'push', '-q', '--force', 'origin', ...branches.map((b) => `${b}:refs/heads/${b}`))
  sh(repo, 'fetch', '-q', '--prune', 'origin')
}
const remoteSha = (b) => sh(repo, 'rev-parse', `refs/remotes/origin/${b}`)
const check = (b, work) => checkBranch(repo, b, work, { env: ENV })

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orphans-'))
  repo = path.join(root, 'repo')
  sh(root, 'init', '-q', '--bare', path.join(root, 'remote.git'))
  sh(root, 'init', '-q', '-b', 'main', repo)
  sh(repo, 'config', 'user.email', 't@example.com')
  sh(repo, 'config', 'user.name', 't')
  sh(repo, 'remote', 'add', 'origin', path.join(root, 'remote.git'))
  commit('a.txt', 'one\n')
  sh(repo, 'branch', 'feat/thing')
  publish('main', 'feat/thing')
  sh(repo, 'checkout', '-q', '-b', 'claude/thing-ab12cd', 'feat/thing')
})

afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }))

test('a session branch merged into the integration branch is safe', () => {
  commit('b.txt', 'work\n')
  sh(repo, 'checkout', '-q', 'main')
  sh(repo, 'merge', '-q', '--no-ff', '-m', 'merge', 'claude/thing-ab12cd')
  publish('main', 'claude/thing-ab12cd')
  assert.equal(check('claude/thing-ab12cd', 'feat/thing').safe, true)
})

test('commits only the session branch holds are orphans, and a fast-forward of the work branch', () => {
  const sha = commit('b.txt', 'work\n')
  publish('claude/thing-ab12cd')
  const c = check('claude/thing-ab12cd', 'feat/thing')
  assert.deepEqual([c.safe, c.orphans, c.fastForward], [false, [sha], true])
})

test('a cherry-pick or a squash on the integration branch keeps the work', () => {
  const sha = commit('b.txt', 'work\n')
  publish('claude/thing-ab12cd')
  sh(repo, 'checkout', '-q', 'main')
  sh(repo, 'cherry-pick', sha)
  publish('main')
  assert.equal(check('claude/thing-ab12cd', 'feat/thing').safe, true)
  sh(repo, 'checkout', '-q', 'claude/thing-ab12cd')
  commit('c.txt', 'more\n')
  publish('claude/thing-ab12cd')
  sh(repo, 'checkout', '-q', 'main')
  sh(repo, 'merge', '-q', '--squash', 'claude/thing-ab12cd')
  sh(repo, 'commit', '-q', '-m', 'squash')
  publish('main')
  assert.equal(check('claude/thing-ab12cd', 'feat/thing').safe, true)
})

test('another session branch or a train branch is not a kept home', () => {
  const sha = commit('b.txt', 'work\n')
  sh(repo, 'branch', 'train/live')
  publish('claude/thing-ab12cd', 'train/live')
  assert.deepEqual(check('claude/thing-ab12cd', 'feat/thing').orphans, [sha])
  assert.deepEqual(scan(repo, { trains: true, env: ENV }).map((c) => [c.branch, c.safe]), [['claude/thing-ab12cd', false], ['train/live', false]])
})

test('the work branch is found by the session slug, and not guessed when nothing fits', () => {
  commit('b.txt', 'work\n')
  publish('claude/thing-ab12cd')
  assert.equal(workBranchFor(repo, 'claude/thing-ab12cd', undefined, ENV), 'feat/thing')
  sh(repo, 'checkout', '-q', '-b', 'claude/other-zz99zz', 'main')
  commit('z.txt', 'z\n')
  publish('claude/other-zz99zz')
  assert.equal(workBranchFor(repo, 'claude/other-zz99zz', undefined, ENV), null)
})

test('rescue fast-forwards the work branch, after which nothing is orphaned', () => {
  const sha = commit('b.txt', 'work\n')
  publish('claude/thing-ab12cd')
  assert.equal(rescue(repo, check('claude/thing-ab12cd', 'feat/thing')).action, 'pushed')
  sh(repo, 'fetch', '-q', 'origin')
  assert.equal(remoteSha('feat/thing'), sha)
  assert.equal(check('claude/thing-ab12cd', 'feat/thing').safe, true)
})

test('rescue never overwrites a work branch that moved on its own, and needs a work branch', () => {
  commit('b.txt', 'session\n')
  publish('claude/thing-ab12cd')
  sh(repo, 'checkout', '-q', 'feat/thing')
  const own = commit('d.txt', 'own\n')
  publish('feat/thing')
  assert.equal(rescue(repo, check('claude/thing-ab12cd', 'feat/thing')).action, 'diverged')
  assert.equal(remoteSha('feat/thing'), own)
  assert.equal(rescue(repo, check('claude/thing-ab12cd', null)).action, 'unknown-work-branch')
})
