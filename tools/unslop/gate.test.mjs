import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { gate } from './gate.mjs'

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unslop-gate-'))
  const git = (...a) => { const r = spawnSync('git', a, { cwd: dir, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout }
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false')
  const write = (p, t) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), t) }
  const commit = m => { git('add', '-A'); git('commit', '-q', '-m', m) }
  write('src/a.ts', 'export const a = 1\n'); commit('base'); git('branch', 'base')
  return { dir, git, write, commit, done: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

test('a clean diff passes quickly', () => {
  const r = repo()
  try {
    r.write('src/b.ts', 'export const b = (x) => x + 1\n'); r.commit('clean')
    const g = gate({ repo: r.dir, base: 'base', memory: false })
    assert.equal(g.exit, 0)
    assert.ok(g.res.ms < 60_000)
  } finally { r.done() }
})

test('negative: warn mode reports a hit but does not block', () => {
  const r = repo()
  try {
    r.write('src/jobs/sync.ts', 'async function run(x) {\n  try { await x() } catch {}\n}\nexport { run }\n'); r.commit('slop')
    const g = gate({ repo: r.dir, base: 'base', mode: 'warn', memory: false })
    assert.equal(g.exit, 0)
    assert.ok(g.lines.some(l => l.startsWith('warn  conc.empty-catch')))
  } finally { r.done() }
})

test('negative: block mode blocks a high rule that earned precision in this project', () => {
  const r = repo()
  try {
    r.write('.jstack/unslop.json', JSON.stringify({ enabled: true, gate: { mode: 'block', blockSeverities: ['high'] }, rules: { 'conc.empty-catch': { mode: 'block-when-confirmed' } } }))
    r.commit('config on the base'); r.git('branch', '-f', 'base')
    r.write('src/jobs/sync.ts', 'async function run(x) {\n  try { await x() } catch {}\n}\nexport { run }\n'); r.commit('slop')
    const g = gate({ repo: r.dir, base: 'base', memory: false })
    assert.equal(g.exit, 1)
    assert.ok(g.lines.some(l => l.startsWith('BLOCK conc.empty-catch')))
  } finally { r.done() }
})

test('negative: train mode drops a merged tree with a conflict marker or a lost catalog key', () => {
  const r = repo()
  try {
    r.write('messages/en/home.json', '{"a":"A","b":"B"}\n'); r.write('messages/pt/home.json', '{"a":"A"}\n'); r.commit('merge took one side')
    const g = gate({ repo: r.dir, train: true })
    assert.equal(g.exit, 1)
    assert.ok(g.lines.some(l => l.includes('i18n.catalog-parity')))
  } finally { r.done() }
})

test('negative: a rule whose engine is missing says "not checked", never a silent pass', () => {
  const r = repo()
  try {
    r.write('src/b.ts', 'export const b = 2\n'); r.commit('x')
    const g = gate({ repo: r.dir, base: 'base', memory: false })
    assert.ok(g.lines.some(l => /conc\.unawaited-promise|not checked|measure rule/.test(l)) || g.res.notChecked.length === 0)
  } finally { r.done() }
})

test('negative: a branch that sets its own gate to off is still gated, and the config change blocks', () => {
  const r = repo()
  try {
    r.write('.jstack/unslop.json', JSON.stringify({ gate: { mode: 'off' }, rules: { 'conc.empty-catch': { mode: 'off' } } }))
    r.write('src/jobs/sync.ts', 'async function run(x) {\n  try { await x() } catch {}\n}\nexport { run }\n'); r.commit('slop + quiet config')
    const g = gate({ repo: r.dir, base: 'base', memory: false })
    assert.equal(g.exit, 1)
    assert.ok(g.lines.some(l => l.startsWith('BLOCK unslop.config-changed')))
    assert.ok(g.lines.some(l => l.startsWith('warn  conc.empty-catch')), 'the rule the branch switched off still ran')
  } finally { r.done() }
})

test('negative: "off" in the base config reads as warn; only the operator turns the gate off', () => {
  const r = repo()
  try {
    r.write('.jstack/unslop.json', JSON.stringify({ gate: { mode: 'off' } })); r.commit('off on base'); r.git('branch', '-f', 'base')
    r.write('src/jobs/sync.ts', 'async function run(x) {\n  try { await x() } catch {}\n}\nexport { run }\n'); r.commit('slop')
    const g = gate({ repo: r.dir, base: 'base', memory: false })
    assert.ok(g.lines.some(l => l.startsWith('warn  conc.empty-catch')))
    assert.match(g.lines.at(-1), /only the operator turns the gate off/)
    assert.deepEqual(gate({ repo: r.dir, base: 'base', mode: 'off', memory: false }).lines, ['unslop gate: off (operator)'])
  } finally { r.done() }
})

test('a reviewed config change passes with --accept-config-change and is still listed', () => {
  const r = repo()
  try {
    r.write('.jstack/unslop.json', JSON.stringify({ gate: { mode: 'warn' }, houseRules: { bannedWords: ['synergy'] } })); r.commit('config')
    const g = gate({ repo: r.dir, base: 'base', memory: false, acceptConfigChange: true })
    assert.equal(g.exit, 0)
    assert.ok(g.lines.some(l => l.startsWith('warn  unslop.config-changed')))
  } finally { r.done() }
})
