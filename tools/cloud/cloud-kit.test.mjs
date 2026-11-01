// node --test tools/cloud/cloud-kit.test.mjs
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { autocommit, pickKeys, repoSlug, safeTarget } from './cloud-kit.mjs'

const CLOUD = { CLAUDE_CODE_REMOTE: 'true' }
let root, repo, remote

function sh(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-kit-'))
  remote = path.join(root, 'remote.git')
  repo = path.join(root, 'repo')
  sh(root, 'init', '-q', '--bare', remote)
  sh(root, 'init', '-q', '-b', 'feat/work', repo)
  sh(repo, 'config', 'user.email', 't@example.com')
  sh(repo, 'config', 'user.name', 't')
  sh(repo, 'remote', 'add', 'origin', remote)
  fs.writeFileSync(path.join(repo, '.gitignore'), '.env\n')
  sh(repo, 'add', '.')
  sh(repo, 'commit', '-q', '-m', 'init')
})

afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }))

test('reads owner/repo from https, ssh and a proxy remote, and nothing from junk', () => {
  assert.equal(repoSlug('https://github.com/acme/app.git'), 'acme/app')
  assert.equal(repoSlug('git@github.com:acme/app.git'), 'acme/app')
  assert.equal(repoSlug('http://proxy@127.0.0.1:4000/git/acme/app'), 'acme/app')
  assert.equal(repoSlug('nope'), null)
})

test('picks only the named keys, never a longer key with the same prefix', () => {
  assert.equal(pickKeys('KEY="a"\nKEY_PRODUCTION="b"\n', ['KEY']), 'KEY="a"')
  assert.equal(pickKeys('KEY_PRODUCTION="b"\n', ['KEY']), '')
  assert.equal(pickKeys('', ['KEY']), '')
})

test('restores only to ignored secret paths inside the repo', () => {
  assert.equal(safeTarget(repo, '.env'), null)
  assert.match(safeTarget(repo, '.env.keys'), /not ignored/)
  assert.match(safeTarget(repo, 'src/app.ts'), /holds back/)
  assert.match(safeTarget(repo, '../.env'), /outside/)
})

test('autocommit saves work and pushes it, holding secrets and minted sessions back', () => {
  fs.writeFileSync(path.join(repo, '.gitignore'), '')
  fs.writeFileSync(path.join(repo, 'work.ts'), 'export {}\n')
  fs.writeFileSync(path.join(repo, '.env'), 'X=1\n')
  fs.mkdirSync(path.join(repo, '.auth'))
  fs.writeFileSync(path.join(repo, '.auth', 's.json'), '{}')
  const r = autocommit(repo, CLOUD)
  assert.equal(r.action, 'pushed')
  assert.deepEqual(r.held.sort(), ['.auth/s.json', '.env'])
  assert.deepEqual(sh(repo, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['.gitignore', 'work.ts'])
  assert.equal(sh(remote, 'rev-parse', 'refs/heads/feat/work'), sh(repo, 'rev-parse', 'HEAD'))
})

test('autocommit does nothing outside the cloud or on a protected branch', () => {
  fs.writeFileSync(path.join(repo, 'work.ts'), 'export {}\n')
  assert.deepEqual(autocommit(repo, {}), { action: 'skipped', reason: 'not a cloud session' })
  sh(repo, 'checkout', '-q', '-B', 'main')
  assert.deepEqual(autocommit(repo, CLOUD), { action: 'skipped', reason: 'protected branch main' })
  sh(repo, 'checkout', '-q', '-B', 'train/live')
  assert.deepEqual(autocommit(repo, CLOUD), { action: 'skipped', reason: 'train branch train/live' })
  sh(repo, 'checkout', '-q', '-B', 'integration')
  assert.deepEqual(autocommit(repo, { ...CLOUD, JSTACK_INTEGRATION_BRANCH: 'integration' }), { action: 'skipped', reason: 'protected branch integration' })
  assert.equal(sh(repo, 'log', '-1', '--format=%s'), 'init')
})

test('autocommit refuses a diff that carries a private key', () => {
  fs.writeFileSync(path.join(repo, 'notes.txt'), 'DOTENV_PRIVATE_KEY_PRODUCTION=deadbeef\n')
  assert.equal(autocommit(repo, CLOUD, { push: false }).action, 'skipped')
  assert.equal(sh(repo, 'log', '-1', '--format=%s'), 'init')
})
