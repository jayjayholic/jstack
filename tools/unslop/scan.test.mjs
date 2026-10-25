import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { scan, parseDiff } from './scan.mjs'
import { loadCases, runCase } from './selftest.mjs'
import { loadRules } from './rules.mjs'

const rulesById = new Map(loadRules({ repo: null }).map(r => [r.id, r]))

// One test per golden fixture: every slop case fires at its lines, every near-miss stays silent.
for (const c of loadCases('dev')) {
  test(`fixture ${c.domain}/${c.id} (${c.kind}) ${c.rule}`, () => {
    const r = runCase(c, rulesById)
    assert.equal(r.error, undefined, r.error)
    assert.deepEqual({ fp: r.fp, fn: r.fn }, { fp: 0, fn: 0 }, `hits: ${JSON.stringify(r.hits)}`)
  })
}

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unslop-scan-'))
  const git = (...a) => {
    const r = spawnSync('git', a, { cwd: dir, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(r.stderr)
    return r.stdout
  }
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 't')
  git('config', 'commit.gpgsign', 'false')
  const write = (p, t) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), t) }
  const commit = m => { git('add', '-A'); git('commit', '-q', '-m', m) }
  return { dir, git, write, commit, done: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

test('diff scope: fires on an added line, not on the same pattern in an unchanged line', () => {
  const r = tempRepo()
  try {
    r.write('src/a.ts', "const old = new Date().toISOString().slice(0, 10)\nexport { old }\n")
    r.commit('base')
    r.git('branch', 'base')
    r.write('src/a.ts', "const old = new Date().toISOString().slice(0, 10)\nconst today = new Date().toISOString().slice(0, 10)\nexport { old, today }\n")
    r.commit('change')
    const res = scan({ repo: r.dir, base: 'base', ruleIds: ['i18n.utc-today'] })
    assert.deepEqual(res.candidates.map(c => c.line), [2])
  } finally { r.done() }
})

test('negative: a deleted line never fires', () => {
  const r = tempRepo()
  try {
    r.write('src/a.ts', "const today = new Date().toISOString().slice(0, 10)\nexport { today }\n")
    r.commit('base')
    r.git('branch', 'base')
    r.write('src/a.ts', 'export {}\n')
    r.commit('remove')
    assert.equal(scan({ repo: r.dir, base: 'base', ruleIds: ['i18n.utc-today'] }).candidates.length, 0)
  } finally { r.done() }
})

test('negative: an inline unslop-ignore with a reason suppresses and is reported as suppressed', () => {
  const r = tempRepo()
  try {
    r.write('src/a.ts', 'export {}\n')
    r.commit('base')
    r.git('branch', 'base')
    r.write('src/a.ts', "// unslop-ignore: i18n.utc-today build stamp, UTC on purpose\nconst stamp = new Date().toISOString().slice(0, 10)\nexport { stamp }\n")
    r.commit('change')
    const res = scan({ repo: r.dir, base: 'base', ruleIds: ['i18n.utc-today'] })
    assert.equal(res.candidates.length, 0)
    assert.match(res.suppressed[0].reason, /UTC on purpose/)
  } finally { r.done() }
})

test('fingerprint is stable when 20 lines are inserted above, and changes when the body changes', () => {
  const r = tempRepo()
  try {
    const body = "function syncBatch(items) {\n  try {\n    send(items)\n  } catch {}\n}\nexport { syncBatch }\n"
    r.write('src/jobs/sync.ts', 'export {}\n')
    r.commit('base')
    r.git('branch', 'base')
    r.write('src/jobs/sync.ts', body)
    r.commit('one')
    const a = scan({ repo: r.dir, base: 'base', ruleIds: ['conc.empty-catch'] }).candidates[0]
    r.write('src/jobs/sync.ts', '// pad\n'.repeat(20) + body)
    r.commit('pad')
    const b = scan({ repo: r.dir, base: 'base', ruleIds: ['conc.empty-catch'] }).candidates[0]
    assert.equal(a.line + 20, b.line)
    assert.equal(a.fingerprint, b.fingerprint)
    r.write('src/jobs/sync.ts', body.replace('send(items)', 'sendAll(items, { force: true })').replace('syncBatch', 'syncAll').replace('syncBatch', 'syncAll'))
    r.commit('change')
    const c = scan({ repo: r.dir, base: 'base', ruleIds: ['conc.empty-catch'] }).candidates[0]
    assert.notEqual(c.fingerprint, a.fingerprint)
  } finally { r.done() }
})

test('negative: a rule with an engine that has no adapter is listed as not checked, never silently passed', () => {
  const res = scan({ root: fs.mkdtempSync(path.join(os.tmpdir(), 'unslop-empty-')), rules: [{ id: 'x.semgrep', domain: 'x', engine: 'semgrep' }] })
  assert.equal(res.notChecked[0].rule, 'x.semgrep')
  assert.match(res.notChecked[0].reason, /not checked/)
})

test('parseDiff reads added line numbers per file', () => {
  const d = parseDiff('+++ b/a.ts\n@@ -1,0 +2,2 @@\n+x\n+y\n+++ b/b.ts\n@@ -3 +3 @@\n-old\n+new\n')
  assert.deepEqual([...d.get('a.ts')], [2, 3])
  assert.deepEqual([...d.get('b.ts')], [3])
})
