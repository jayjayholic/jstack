// node --test tools/memory/location.test.mjs
// Memory outside the repo (JSTACK_MEMORY_DIR / git config jstack.memoryDir): default unchanged, every worktree sees
// the same entries, the READY gate doesn't ask to commit them, the diff-mode scan doesn't trust waivers from there,
// and parallel writers never lose or clobber an entry.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { memoryLocation, fromMsys } from './location.mjs'
import { writeEntry, createEntry, IdTaken } from './memory.mjs'
import { scan } from '../unslop/scan.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HERE, 'memory.mjs')
const TOOLS = path.resolve(HERE, '..')
const cleanEnv = (extra = {}) => { const e = { ...process.env, ...extra }; if (!('JSTACK_MEMORY_DIR' in extra)) delete e.JSTACK_MEMORY_DIR; return e }
const hasBash = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' }).stdout?.trim() === 'ok'

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jstack-memloc-'))
  const dir = path.join(root, 'repo')
  fs.mkdirSync(dir)
  const g = (...a) => { const r = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout }
  g('init', '-q', '-b', 'main')
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export function a() {\n  return 1\n}\n')
  g('add', '.'); g('commit', '-qm', 'init')
  const run = (cwd, args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: cleanEnv(env) })
  return { root, dir, g, run, done: () => fs.rmSync(root, { recursive: true, force: true }) }
}

const entry = (id, extra = {}) => ({ id, kind: 'decision', status: 'active', title: 't', domains: [], anchors: [], created: '2026-10-28T00:00:00Z', ...extra })

test('fromMsys: /c/dev/x is C:/dev/x on Windows only; other paths unchanged', () => {
  assert.equal(fromMsys('/c/dev/hakutaku/.jstack-memory', 'win32'), 'C:/dev/hakutaku/.jstack-memory')
  assert.equal(fromMsys('/c', 'win32'), 'C:/')
  assert.equal(fromMsys('/c/dev/x', 'linux'), '/c/dev/x', 'a real POSIX path stays')
  assert.equal(fromMsys('/home/me/mem', 'win32'), '/home/me/mem', 'not a drive path')
})

test('default unchanged: no setting means <repo>/.jstack/memory, written there, committed with the branch', () => {
  const r = setup()
  try {
    const loc = memoryLocation(r.dir, {})
    assert.equal(loc.external, false)
    assert.equal(loc.from, 'default')
    assert.equal(loc.entries, path.join(r.dir, '.jstack', 'memory', 'entries'))
    const add = r.run(r.dir, ['add', '--kind', 'decision', '--title', 'stays in the repo', '--anchor', 'src/a.ts#a'])
    assert.equal(add.status, 0, add.stderr)
    assert.ok(fs.existsSync(path.join(r.dir, '.jstack', 'memory', 'entries', `${add.stdout.trim()}.json`)))
    assert.equal(r.run(r.dir, ['where', '--tsv']).stdout.trim(), 'repo\t.jstack/memory')
  } finally { r.done() }
})

test('external via env: writes land outside the repo, and a second worktree reads the same entries', () => {
  const r = setup()
  try {
    const ext = path.join(r.root, 'shared-memory')
    const wt2 = path.join(r.root, 'wt2')
    r.g('worktree', 'add', '-q', '-b', 'second', wt2)
    const add = r.run(r.dir, ['add', '--kind', 'convention', '--title', 'one folder for all worktrees', '--anchor', 'src/a.ts#a'], { JSTACK_MEMORY_DIR: ext })
    assert.equal(add.status, 0, add.stderr)
    const id = add.stdout.trim()
    assert.ok(fs.existsSync(path.join(ext, 'entries', `${id}.json`)))
    assert.ok(!fs.existsSync(path.join(r.dir, '.jstack')), 'nothing written in the repo')
    const q = JSON.parse(r.run(wt2, ['query', '--paths', 'src/a.ts', '--json'], { JSTACK_MEMORY_DIR: ext }).stdout)
    assert.deepEqual(q.map(x => x.entry.id), [id])
    assert.equal(q[0].anchors[0].status, 'FRESH', 'anchors resolve against the worktree it runs in')
    assert.match(r.run(wt2, ['where', '--tsv'], { JSTACK_MEMORY_DIR: ext }).stdout, /^external\t/)
  } finally { r.done() }
})

test('external via git config: a relative path resolves against the main checkout from every worktree', () => {
  const r = setup()
  try {
    const wt2 = path.join(r.root, 'wt2')
    r.g('worktree', 'add', '-q', '-b', 'second', wt2)
    r.g('config', 'jstack.memoryDir', '../shared-memory')
    const want = path.join(r.root, 'shared-memory')
    for (const w of [r.dir, wt2]) {
      const loc = memoryLocation(w, {})
      assert.equal(fs.realpathSync.native(path.dirname(loc.dir)), fs.realpathSync.native(r.root), w)
      assert.equal(path.basename(loc.dir), 'shared-memory')
      assert.equal(loc.external, true)
      assert.equal(loc.from, 'git config jstack.memoryDir')
    }
    const id = r.run(wt2, ['add', '--kind', 'decision', '--title', 'from the second worktree']).stdout.trim()
    assert.ok(fs.existsSync(path.join(want, 'entries', `${id}.json`)))
    assert.deepEqual(JSON.parse(r.run(r.dir, ['export']).stdout).map(e => e.id), [id])
    // the env var wins over git config
    assert.equal(memoryLocation(r.dir, { JSTACK_MEMORY_DIR: path.join(r.root, 'other') }).dir, path.join(r.root, 'other'))
  } finally { r.done() }
})

test('negative: a JSTACK_MEMORY_DIR inside the repo is not external, so its entries must still be committed', () => {
  const r = setup()
  try {
    const loc = memoryLocation(r.dir, { JSTACK_MEMORY_DIR: path.join(r.dir, 'docs', 'memory') })
    assert.equal(loc.external, false)
    assert.equal(loc.rel, 'docs/memory')
  } finally { r.done() }
})

function readyGate(r, env) {
  const sha = r.g('rev-parse', 'HEAD').trim()
  const stamps = path.join(r.dir, '.git', 'jstack-ready')
  fs.mkdirSync(stamps, { recursive: true })
  fs.writeFileSync(path.join(stamps, `${sha}.tc.ok`), '')
  return spawnSync('bash', [path.join(TOOLS, 'ready-gate.sh'), '.', '--base', 'main', '--no-brief'], {
    cwd: r.dir, encoding: 'utf8',
    env: cleanEnv({ JSTACK_CONFIG: path.join(r.root, 'no-config.sh'), JSTACK_TOOLS: TOOLS, JSTACK_READY_UNSLOP: 'off', JSTACK_READY_PREFLIGHT: 'off', JSTACK_UNIT_TEST_CMD: '', ...env }),
  })
}

function branchWithEntry(r, env) {
  r.g('checkout', '-q', '-b', 'feature')
  fs.writeFileSync(path.join(r.dir, 'notes.txt'), 'a change\n')
  r.g('add', '.'); r.g('commit', '-qm', 'change')
  const add = r.run(r.dir, ['add', '--kind', 'known-slop', '--status', 'fixed', '--title', 'a lesson', '--anchor', 'src/a.ts#a'], env)
  assert.equal(add.status, 0, add.stderr)
}

test('READY gate: external memory is not "uncommitted records", and the anchor check still runs', { skip: !hasBash && 'no bash' }, () => {
  const r = setup()
  try {
    const env = { JSTACK_MEMORY_DIR: path.join(r.root, 'shared-memory') }
    branchWithEntry(r, env)
    const out = readyGate(r, env)
    assert.doesNotMatch(out.stdout, /unslop records not committed/)
    assert.match(out.stdout, /memory entries live outside the repo/)
    assert.match(out.stdout, /PASS {2}memory anchors/)
    assert.equal(out.status, 0, out.stdout + out.stderr)
  } finally { r.done() }
})

test('negative: READY gate still refuses an untracked entry when memory lives in the repo (default)', { skip: !hasBash && 'no bash' }, () => {
  const r = setup()
  try {
    branchWithEntry(r, {})
    const out = readyGate(r, {})
    assert.match(out.stdout, /FAIL {2}unslop records not committed/)
    assert.equal(out.status, 1)
  } finally { r.done() }
})

test('trust: in diff mode an external waiver suppresses nothing; --full reads it', () => {
  const r = setup()
  try {
    r.g('config', 'jstack.memoryDir', '../shared-memory')
    const slop = 'async function run(x) {\n  try { await x() } catch {}\n}\nexport { run }\n'
    r.g('checkout', '-q', '-b', 'feature')
    fs.mkdirSync(path.join(r.dir, 'src', 'jobs'), { recursive: true })
    fs.writeFileSync(path.join(r.dir, 'src', 'jobs', 'sync.ts'), slop)
    r.g('add', '.'); r.g('commit', '-qm', 'slop')
    const first = scan({ repo: r.dir, base: 'main', ruleIds: ['conc.empty-catch'] })
    assert.equal(first.candidates.length, 1)
    const fp = first.candidates[0].fingerprint
    writeEntry(r.dir, { ...entry('20261028-0000-aaaaaa', { kind: 'known-slop', status: 'waived', fingerprint: fp, waiver: { reason: 'later', expires: new Date(Date.now() + 86400000).toISOString() } }) })
    const diff = scan({ repo: r.dir, base: 'main', ruleIds: ['conc.empty-catch'] })
    assert.equal(diff.memorySource, 'external-untrusted')
    assert.deepEqual(diff.candidates.map(c => c.rule), ['conc.empty-catch'], 'an agent cannot waive its own hit from the shared folder')
    const full = scan({ repo: r.dir, full: 'src', ruleIds: ['conc.empty-catch'] })
    assert.equal(full.candidates.length, 0, 'full mode has no base, reads the folder as the working tree')
  } finally { r.done() }
})

test('concurrency: create never overwrites an existing id, and createEntry draws a new one', () => {
  const r = setup()
  try {
    r.g('config', 'jstack.memoryDir', '../shared-memory')
    writeEntry(r.dir, entry('20261028-0000-bbbbbb', { title: 'first' }), { create: true })
    assert.throws(() => writeEntry(r.dir, entry('20261028-0000-bbbbbb', { title: 'second' }), { create: true }), IdTaken)
    const e = entry('20261028-0000-bbbbbb', { title: 'second' })
    createEntry(r.dir, e)
    assert.notEqual(e.id, '20261028-0000-bbbbbb')
    const dir = path.join(r.root, 'shared-memory', 'entries')
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '20261028-0000-bbbbbb.json'), 'utf8')).title, 'first')
    assert.deepEqual(fs.readdirSync(dir).filter(f => f.endsWith('.tmp')), [], 'no temp files left')
  } finally { r.done() }
})

test('concurrency: 8 processes x 5 adds at once land 40 valid entries, nothing lost or half-written', async () => {
  const r = setup()
  try {
    const ext = path.join(r.root, 'shared-memory')
    const script = `for i in 1 2 3 4 5; do "${process.execPath.replace(/\\/g, '/')}" "${CLI.replace(/\\/g, '/')}" add --kind decision --title "w$W-$i" --anchor src/a.ts#a || exit 1; done`
    const one = w => new Promise(res => {
      const p = hasBash
        ? spawn('bash', ['-c', script], { cwd: r.dir, env: cleanEnv({ JSTACK_MEMORY_DIR: ext, W: String(w) }) })
        : spawn(process.execPath, ['-e', `const {spawnSync}=require('child_process');for(let i=1;i<=5;i++){if(spawnSync(process.execPath,[${JSON.stringify(CLI)},'add','--kind','decision','--title','w${w}-'+i,'--anchor','src/a.ts#a']).status)process.exit(1)}`], { cwd: r.dir, env: cleanEnv({ JSTACK_MEMORY_DIR: ext }) })
      p.on('close', code => res(code))
    })
    const codes = await Promise.all([...Array(8).keys()].map(one))
    assert.deepEqual(codes, Array(8).fill(0))
    const files = fs.readdirSync(path.join(ext, 'entries'))
    assert.equal(files.filter(f => f.endsWith('.json')).length, 40)
    assert.deepEqual(files.filter(f => f.endsWith('.tmp')), [])
    const lint = r.run(r.dir, ['lint'], { JSTACK_MEMORY_DIR: ext })
    assert.equal(lint.status, 0, lint.stdout)
    const titles = JSON.parse(r.run(r.dir, ['export'], { JSTACK_MEMORY_DIR: ext }).stdout).map(e => e.title).sort()
    assert.equal(new Set(titles).size, 40)
  } finally { r.done() }
})
