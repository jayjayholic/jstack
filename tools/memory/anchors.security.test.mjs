// node --test tools/memory/anchors.security.test.mjs
// A memory entry is a file a branch can edit, so every value from it that reaches git is checked first.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { makeAnchor, resolveAnchor, isCommitId, isSafeRelPath, verifiedCommit } from './anchors.mjs'
import { validate } from './memory.mjs'

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'memory.mjs')

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jstack-anchor-sec-'))
  const g = (...a) => { const r = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { cwd: dir, encoding: 'utf8' }); if (r.status) throw new Error(r.stderr); return r.stdout.trim() }
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export function keep() {\n  return 1\n}\n')
  g('init', '-q'); g('add', '.'); g('commit', '-qm', 'init')
  return { dir, g, done: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

const entry = (anchors) => ({ id: '20261025-1200-abcdef', kind: 'decision', status: 'active', title: 't', domains: [], anchors, created: '2026-10-25T12:00:00Z' })

test('a real commit id still resolves: verifiedCommit returns the full id and the anchor is FRESH', () => {
  const r = repo()
  try {
    const a = makeAnchor(r.dir, 'src/a.ts#keep')
    assert.ok(isCommitId(a.commit))
    assert.match(verifiedCommit(r.dir, a.commit), /^[0-9a-f]{40}$/)
    assert.equal(resolveAnchor(r.dir, a).status, 'FRESH')
    assert.deepEqual(validate(entry([a])), [])
  } finally { r.done() }
})

test('negative: an option-shaped commit never reaches git, so --output cannot write a file', () => {
  const r = repo()
  try {
    const pwned = path.join(r.dir, 'pwned.txt')
    const evil = `--output=${pwned.replace(/\\/g, '/')}`
    // The file is gone and the symbol is gone, so resolution walks every git path: rename, old body, log.
    fs.rmSync(path.join(r.dir, 'src', 'a.ts'))
    const res = resolveAnchor(r.dir, { path: 'src/a.ts', symbol: 'keep', commit: evil, hash: 'x', lang: 'ts' })
    assert.equal(res.status, 'STALE')
    assert.equal(fs.existsSync(pwned), false)
    assert.equal(verifiedCommit(r.dir, evil), null)
    assert.equal(verifiedCommit(r.dir, 'deadbeefdeadbeef'), null, 'hex that names no commit is refused too')
    assert.ok(validate(entry([{ path: 'src/a.ts', commit: evil }])).some(e => /commit/.test(e)))
    // Same through the CLI on a hand-written entry: check runs, nothing is written.
    fs.mkdirSync(path.join(r.dir, '.jstack', 'memory', 'entries'), { recursive: true })
    fs.writeFileSync(path.join(r.dir, '.jstack', 'memory', 'entries', '20261025-1200-abcdef.json'), JSON.stringify(entry([{ path: 'src/a.ts', symbol: 'keep', commit: evil, hash: 'x' }])))
    spawnSync(process.execPath, [CLI, 'check', '--repo', r.dir], { encoding: 'utf8' })
    assert.equal(fs.existsSync(pwned), false)
    assert.equal(spawnSync(process.execPath, [CLI, 'lint', '--repo', r.dir], { encoding: 'utf8' }).status, 1)
  } finally { r.done() }
})

test('negative: absolute, parent and option-shaped anchor paths are refused everywhere', () => {
  const r = repo()
  try {
    for (const bad of ['../outside.ts', 'src/../../x.ts', '-x.ts', '/etc/passwd', 'C:/Windows/win.ini', '..\\x.ts']) {
      assert.equal(isSafeRelPath(bad), false, bad)
      assert.throws(() => makeAnchor(r.dir, bad), /refused/, bad)
      assert.equal(resolveAnchor(r.dir, { path: bad, symbol: null, commit: null, hash: 'x' }).status, 'STALE', bad)
      assert.ok(validate(entry([{ path: bad }])).some(e => /repo-relative/.test(e)), bad)
    }
    assert.equal(isSafeRelPath('src/a.ts'), true)
    assert.throws(() => makeAnchor(r.dir, 'src/a.ts', { commit: 'HEAD~1' }), /commit refused/)
  } finally { r.done() }
})
