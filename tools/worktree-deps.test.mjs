import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'

const SCRIPT = path.resolve(import.meta.dirname, 'worktree-deps.mjs')
const FAKE_INSTALL = `node -e "const fs=require('fs');fs.mkdirSync('node_modules/left-pad',{recursive:true});fs.writeFileSync('node_modules/left-pad/index.js','');fs.mkdirSync('node_modules/@acme',{recursive:true});fs.mkdirSync('node_modules/@acme/lib',{recursive:true});fs.mkdirSync('node_modules/.cache',{recursive:true})"`

let sandbox
let main
let stores

const sh = (cwd, cmd, args) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const deps = (cwd, ...args) =>
	sh(cwd, process.execPath, [SCRIPT, ...args]).trim()
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, '\t')}\n`)
const addWorktree = (name) => {
	const dir = path.join(sandbox, name)
	sh(main, 'git', ['worktree', 'add', '-q', '-b', name, dir, 'stage'])
	return dir
}

before(() => {
	sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-deps-'))
	main = path.join(sandbox, 'main')
	stores = path.join(sandbox, 'stores')
	fs.mkdirSync(path.join(main, 'packages', 'core'), { recursive: true })
	writeJson(path.join(main, 'package.json'), { name: 'app', workspaces: ['packages/*'], dependencies: { 'left-pad': '1.3.0' }, scripts: {} })
	writeJson(path.join(main, 'packages', 'core', 'package.json'), { name: '@acme/core', dependencies: {} })
	fs.writeFileSync(path.join(main, 'packages', 'core', 'index.js'), 'export const core = 1\n')
	fs.writeFileSync(path.join(main, 'bun.lock'), '{"lockfileVersion":1}\n')
	sh(main, 'git', ['init', '-q', '-b', 'stage'])
	sh(main, 'git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'root'])
	sh(main, 'git', ['add', '.'])
	sh(main, 'git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'])
	process.env.WORKTREE_DEPS_STORES = stores
	process.env.WORKTREE_DEPS_STORE_INSTALL = FAKE_INSTALL
	process.env.JSTACK_INSTALL_CMD = FAKE_INSTALL
	process.env.JSTACK_RAM_CLEAN_TASK = ''
})

after(() => fs.rmSync(sandbox, { recursive: true, force: true }))

test('an unchanged branch links the shared store and its own workspace packages', () => {
	const a = addWorktree('a')
	const b = addWorktree('b')
	deps(a, 'deps', '--base', 'stage')
	deps(b, 'deps', '--base', 'stage')
	const shared = fs.realpathSync(path.join(a, 'node_modules', 'left-pad'))
	assert.equal(shared, fs.realpathSync(path.join(b, 'node_modules', 'left-pad')))
	assert.ok(shared.startsWith(fs.realpathSync(stores)))
	assert.equal(fs.realpathSync(path.join(a, 'node_modules', '@acme', 'core')), fs.realpathSync(path.join(a, 'packages', 'core')))
	assert.equal(fs.realpathSync(path.join(b, 'node_modules', '@acme', 'core')), fs.realpathSync(path.join(b, 'packages', 'core')))
	assert.equal(fs.realpathSync(path.join(a, 'node_modules', '@acme', 'lib')), fs.realpathSync(path.join(b, 'node_modules', '@acme', 'lib')))
	assert.equal(fs.lstatSync(path.join(a, 'node_modules', '.cache')).isSymbolicLink(), false)
	assert.match(deps(a, 'status'), /node_modules: shared/)
})

test('a branch that changed a dependency installs its own node_modules', () => {
	const c = addWorktree('c')
	const manifest = path.join(c, 'packages', 'core', 'package.json')
	writeJson(manifest, { name: '@acme/core', dependencies: { 'is-number': '7.0.0' } })
	assert.deepEqual(JSON.parse(deps(c, 'plan', '--base', 'stage').replace(/'/g, '"')), ['packages/core/package.json'])
	deps(c, 'deps', '--base', 'stage')
	assert.match(deps(c, 'status'), /node_modules: own install/)
	assert.equal(fs.lstatSync(path.join(c, 'node_modules', 'left-pad')).isSymbolicLink(), false)
})

test('script-only package.json edits and lockfile edits are told apart', () => {
	const d = addWorktree('d')
	const manifest = path.join(d, 'package.json')
	writeJson(manifest, { ...JSON.parse(fs.readFileSync(manifest, 'utf8')), scripts: { dev: 'next dev' } })
	assert.equal(deps(d, 'plan', '--base', 'stage'), '[]')
	fs.appendFileSync(path.join(d, 'bun.lock'), ' ')
	assert.match(deps(d, 'plan', '--base', 'stage'), /bun\.lock/)
})

test('detach turns a linked folder back into an empty own one without touching the store', () => {
	const e = addWorktree('e')
	deps(e, 'deps', '--base', 'stage')
	const storeFile = fs.realpathSync(path.join(e, 'node_modules', 'left-pad', 'index.js'))
	deps(e, 'detach', 'node_modules')
	assert.equal(fs.existsSync(path.join(e, 'node_modules')), false)
	assert.ok(fs.existsSync(storeFile))
})

test('own deps gives the worktree its own install, keeps it on later runs, and leaves the store alone', () => {
	const g = addWorktree('g')
	deps(g, 'deps', '--base', 'stage')
	const storeFile = fs.realpathSync(path.join(g, 'node_modules', 'left-pad', 'index.js'))
	assert.match(deps(g, 'own', 'deps'), /own now/)
	assert.match(deps(g, 'status'), /own by choice: deps/)
	assert.match(deps(g, 'status'), /node_modules: own install/)
	assert.match(deps(g, 'deps', '--base', 'stage'), /chose its own node_modules/)
	assert.match(deps(g, 'status'), /node_modules: own install/)
	assert.ok(fs.existsSync(storeFile))
	assert.match(deps(g, 'share', 'deps', '--base', 'stage'), /linked to shared store/)
	assert.match(deps(g, 'status'), /own by choice: nothing/)
})

test('own and share refuse anything but deps or generated', () => {
	const h = addWorktree('h')
	assert.throws(() => deps(h, 'own', 'node_modules'), /usage/)
	assert.throws(() => deps(h, 'share'), /usage/)
})

test('remove unlinks every junction before git deletes the worktree, so the shared store survives', () => {
	const f = addWorktree('f')
	deps(f, 'deps', '--base', 'stage')
	const storeFile = fs.realpathSync(path.join(f, 'node_modules', 'left-pad', 'index.js'))
	const outside = path.join(sandbox, 'outside')
	fs.mkdirSync(outside)
	fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep')
	fs.symlinkSync(outside, path.join(f, '.generated'), 'junction')
	deps(main, 'remove', f, '--delete-branch')
	assert.equal(fs.existsSync(f), false)
	assert.ok(fs.existsSync(storeFile))
	assert.ok(fs.existsSync(path.join(outside, 'keep.txt')))
	assert.equal(sh(main, 'git', ['branch', '--list', 'f']).trim(), '')
})

const removeOutput = (...args) => {
	const run = spawnSync(process.execPath, [SCRIPT, 'remove', ...args], { cwd: main, encoding: 'utf8' })
	return `${run.stdout}${run.stderr}`
}
const branchExists = (name) => sh(main, 'git', ['branch', '--list', name]).trim() !== ''

test('remove on a half-deleted worktree never reads or deletes the main checkout branch', () => {
	const g = path.join(main, '.worktrees', 'half')
	sh(main, 'git', ['worktree', 'add', '-q', '-b', 'half', g, 'stage'])
	fs.rmSync(path.join(g, '.git'), { force: true })
	const out = removeOutput(g, '--delete-branch')
	assert.doesNotMatch(out, /and branch/)
	assert.doesNotMatch(out, /branch -D|Deleted branch|cannot delete/i)
	assert.ok(branchExists('stage'))
	assert.equal(fs.existsSync(g), false)
})

test('remove refuses to delete a protected branch and says so', () => {
	const h = path.join(sandbox, 'h-master')
	sh(main, 'git', ['worktree', 'add', '-q', '-b', 'master', h, 'stage'])
	const out = removeOutput(h, '--delete-branch')
	assert.match(out, /not deleting protected branch master/)
	assert.ok(branchExists('master'))
	assert.equal(fs.existsSync(h), false)
})

test('remove deletes the branch of a normal worktree', () => {
	const k = addWorktree('k')
	const out = removeOutput(k, '--delete-branch')
	assert.match(out, /and branch k/)
	assert.equal(branchExists('k'), false)
})
