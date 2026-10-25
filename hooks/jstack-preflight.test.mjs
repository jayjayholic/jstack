// node --test hooks/jstack-preflight.test.mjs
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { edit, suggestClass, readPreflight, packDigest } from './jstack-preflight.mjs'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jstack-preflight-test-'))
const repo = path.join(tmp, 'repo')
const plain = path.join(tmp, 'plain')
const cfgFile = path.join(tmp, 'guards.json')
let env
let n = 0
const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' })

before(() => {
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true })
  fs.mkdirSync(plain, { recursive: true })
  git('init', '-q', '-b', 'feat/new-flow')
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1\n')
  git('add', '.'); git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'init')
  fs.writeFileSync(cfgFile, JSON.stringify({ projects: [] }))
})

beforeEach(() => {
  fs.rmSync(path.join(repo, '.agent'), { recursive: true, force: true })
  env = { JSTACK_GUARDS_CONFIG: cfgFile, CLAUDE_PLUGIN_DATA: path.join(tmp, `data${++n}`) }
})

after(() => fs.rmSync(tmp, { recursive: true, force: true }))

const call = (file, extra = {}) => edit({ session_id: 's', agent_id: extra.agent ?? 'a1', cwd: extra.cwd ?? repo, tool_name: extra.tool ?? 'Edit', tool_input: { file_path: file } }, extra.env ?? env)
const ctx = out => out?.hookSpecificOutput?.additionalContext ?? ''
const writePf = text => { fs.mkdirSync(path.join(repo, '.agent'), { recursive: true }); fs.writeFileSync(path.join(repo, '.agent', 'preflight.md'), text) }

test('first edit in a repo without a pre-flight gets one nudge, never a deny', () => {
  const out = call(path.join(repo, 'src', 'a.ts'))
  assert.match(ctx(out), /no \.agent\/preflight\.md/)
  assert.equal(out.hookSpecificOutput.permissionDecision, undefined)
  assert.equal(call(path.join(repo, 'src', 'a.ts')), null, 'second edit in the same session is silent')
})

test('an old .agent marker file is pointed out, since it blocks the .agent folder', () => {
  fs.writeFileSync(path.join(repo, '.agent'), 'me: task\n')
  assert.match(ctx(call(path.join(repo, 'src', 'a.ts'))), /\.agent is a file here/)
  fs.rmSync(path.join(repo, '.agent'))
})

test('another agent in the same session gets its own nudge', () => {
  assert.ok(ctx(call(path.join(repo, 'src', 'a.ts'), { agent: 'x' })))
  assert.ok(ctx(call(path.join(repo, 'src', 'a.ts'), { agent: 'y' })))
})

test('non-git directories, .agent files and non-edit tools are ignored', () => {
  assert.equal(call(path.join(plain, 'notes.md'), { cwd: plain }), null)
  assert.equal(call(path.join(repo, '.agent', 'preflight.md')), null)
  assert.equal(call(path.join(repo, 'src', 'a.ts'), { tool: 'Read' }), null)
})

test('a quick-class pre-flight line silences the hook on ordinary files', () => {
  writePf('class: quick - typo in a label\n')
  assert.equal(call(path.join(repo, 'src', 'a.ts')), null)
})

test('a quick class still gets one note when the edit reaches a risk path', () => {
  writePf('class: quick - small fix\n')
  assert.match(ctx(call(path.join(repo, 'prisma', 'migrations', '001', 'migration.sql'))), /full whatever the branch says/)
  assert.equal(call(path.join(repo, 'src', 'auth', 'session.ts')), null, 'once only')
})

test('a quick class that grows past quick size gets one note, checked every 10 edits', () => {
  writePf('class: quick - small fix\n')
  for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(repo, 'src', `g${i}.ts`), 'x\n'.repeat(40))
  git('add', '-N', 'src')
  const notes = []
  for (let i = 0; i < 20; i++) { const t = ctx(call(path.join(repo, 'src', 'a.ts'))); if (t) notes.push(t) }
  assert.equal(notes.length, 1)
  assert.match(notes[0], /diff is now 1\d file\(s\)/)
  for (let i = 0; i < 10; i++) fs.rmSync(path.join(repo, 'src', `g${i}.ts`))
  git('add', '-A', 'src')
  git('reset', '-q')
})

test('a full pre-flight with domains loads those packs into context once', () => {
  writePf('# Pre-flight: x   tier: M (y)\n\n## Domains\n\neng-concurrency (apply once)\n\n## Answers\n')
  const text = ctx(call(path.join(repo, 'src', 'a.ts')))
  assert.match(text, /concurrency \(jstack:eng-concurrency\)/)
  assert.match(text, /commit point/i)
  assert.match(text, /red flags/)
  assert.equal(call(path.join(repo, 'src', 'a.ts')), null)
})

test('a pre-flight written for another branch counts as missing', () => {
  writePf('class: quick - other\nbranch: fix/other\n')
  assert.match(ctx(call(path.join(repo, 'src', 'a.ts'))), /no \.agent\/preflight\.md/)
})

test('opt-out by env and by config', () => {
  assert.equal(call(path.join(repo, 'src', 'a.ts'), { env: { ...env, JSTACK_PREFLIGHT: 'off' } }), null)
  const off = path.join(tmp, 'off.json')
  fs.writeFileSync(off, JSON.stringify({ preflight: { enabled: false } }))
  assert.equal(call(path.join(repo, 'src', 'a.ts'), { env: { ...env, JSTACK_GUARDS_CONFIG: off } }), null)
})

test('fail-safe: a broken payload or config never throws', () => {
  const bad = path.join(tmp, 'bad.json')
  fs.writeFileSync(bad, '{not json')
  assert.doesNotThrow(() => call(path.join(repo, 'src', 'a.ts'), { env: { ...env, JSTACK_GUARDS_CONFIG: bad } }))
  assert.equal(edit({ tool_name: 'Edit', tool_input: {} }, env), null)
  const r = spawnSync(process.execPath, [path.join(import.meta.dirname, 'run-hook.mjs'), 'edit'], { input: 'garbage', encoding: 'utf8', env: { ...process.env, ...env } })
  assert.equal(r.status, 0)
  assert.equal(r.stdout, '')
})

test('suggestClass: hotfix branch and quick words go quick, risk paths go full, nothing goes light', () => {
  assert.equal(suggestClass({ branch: 'hotfix/x', files: ['src/a.ts'], lines: 5 }).cls, 'quick')
  assert.equal(suggestClass({ branch: 'x', ask: 'swap rápido da chave' }).cls, 'quick')
  assert.equal(suggestClass({ branch: 'fix/y', files: ['a', 'b'], lines: 20 }).cls, 'quick')
  assert.equal(suggestClass({ branch: 'fix/y', files: [], lines: 0 }).cls, 'light', 'an empty diff at the first edit is no evidence of a small fix')
  assert.equal(suggestClass({ branch: 'fix/y', ask: 'make applyChanges idempotent per proposal' }).cls, 'full')
  assert.equal(suggestClass({ branch: 'hotfix/x', target: 'packages/ai/src/models.ts' }).cls, 'full')
  assert.equal(suggestClass({ branch: 'hotfix/x', files: Array(12).fill('f'), lines: 900 }).cls, 'full', 'a big diff is not quick whatever the branch')
  assert.equal(suggestClass({ branch: 'hotfix/x', target: 'src/lib/billing/charge.ts' }).cls, 'full')
  assert.equal(suggestClass({ branch: 'fix/z', files: ['db/migrations/1.sql'] }).cls, 'full')
  assert.equal(suggestClass({ branch: 'feat/new-flow' }).cls, 'full')
  assert.equal(suggestClass({ branch: 'fix/y', files: Array(5).fill('f'), lines: 120 }).cls, 'light')
  assert.equal(suggestClass({ branch: 'wip' }).cls, 'light')
})

test('readPreflight reads class, tier and domains from the three formats', () => {
  writePf('class: quick - typo\n')
  assert.deepEqual(readPreflight(repo, 'feat/new-flow'), { cls: 'quick', tier: 'S', domains: [] })
  writePf('class: light\nask: "x"\ncheck: bun test -> green\nscope: src/a.ts\ndomains: concurrency, security\n')
  assert.deepEqual(readPreflight(repo, '').domains, ['concurrency', 'security'])
  writePf('# Pre-flight: x   tier: L (y)\n\n## Domains\n\n| domain | why |\n|---|---|\n| llm-cost | paid calls |\n')
  const pf = readPreflight(repo, '')
  assert.equal(pf.cls, 'full'); assert.equal(pf.tier, 'L'); assert.ok(pf.domains.includes('llm-cost'))
})

test('packDigest stays bounded and skips unknown domains', () => {
  assert.equal(packDigest(['nope'], 'S'), '')
  const all = packDigest(['security', 'concurrency', 'llm-cost', 'data-privacy', 'ui-visual', 'performance'], 'M', 3000)
  assert.ok(all.length <= 3100)
})
