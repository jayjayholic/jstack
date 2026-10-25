// node --test tools/unslop/scan.trust.test.mjs
// Waivers expire, high-severity waivers must say when, and in diff mode a branch can't waive or switch off the
// checks that judge it: suppressions and config come from the merge-base, and new ones show up as hits.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { scan, waiverActive } from './scan.mjs'

const SLOP = 'async function run(x) {\n  try { await x() } catch {}\n}\nexport { run }\n'
const DAY = 86400000

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unslop-trust-'))
  const git = (...a) => { const r = spawnSync('git', a, { cwd: dir, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout }
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false')
  const write = (p, t) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), typeof t === 'string' ? t : JSON.stringify(t, null, 2)) }
  const commit = m => { git('add', '-A'); git('commit', '-q', '-m', m) }
  write('src/a.ts', 'export const a = 1\n'); commit('base')
  return { dir, git, write, commit, done: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

// The fingerprint the slop gets in a branch off base: scan once, read it back.
function fingerprint(r) {
  r.git('checkout', '-q', '-b', 'probe')
  r.write('src/jobs/sync.ts', SLOP); r.commit('probe')
  const fp = scan({ repo: r.dir, base: 'main', ruleIds: ['conc.empty-catch'] }).candidates[0].fingerprint
  r.git('checkout', '-q', 'main'); r.git('branch', '-q', '-D', 'probe')
  return fp
}

const waived = (id, fp, expires) => ({ id, kind: 'known-slop', status: 'waived', title: 'w', domains: [], anchors: [], fingerprint: fp, waiver: { reason: 'migrating next sprint', expires }, created: '2026-10-25T00:00:00Z' })
const branchWithSlop = r => { r.git('checkout', '-q', '-b', 'feature'); r.write('src/jobs/sync.ts', SLOP); r.commit('slop') }
const rules = res => res.candidates.map(c => c.rule).sort()

test('waiverActive: future expiry yes, past or garbage no, no expiry only below high', () => {
  const now = Date.parse('2026-10-25T00:00:00Z')
  assert.equal(waiverActive({ waiver: true, expires: '2026-11-01' }, 'high', now), true)
  assert.equal(waiverActive({ waiver: true, expires: '2026-10-01' }, 'low', now), false)
  assert.equal(waiverActive({ waiver: true, expires: 'soon' }, 'low', now), false)
  assert.equal(waiverActive({ waiver: true, expires: null }, 'high', now), false)
  assert.equal(waiverActive({ waiver: true, expires: null }, 'medium', now), true)
  assert.equal(waiverActive({ waiver: false }, 'high', now), true, 'a known false positive is not a waiver')
})

test('a memory waiver on the base with a future expiry suppresses the hit', () => {
  const r = repo()
  try {
    const fp = fingerprint(r)
    r.write('.jstack/memory/entries/20261025-0000-aaaaaa.json', waived('20261025-0000-aaaaaa', fp, new Date(Date.now() + 30 * DAY).toISOString()))
    r.commit('waiver reviewed on main')
    branchWithSlop(r)
    const res = scan({ repo: r.dir, base: 'main', ruleIds: ['conc.empty-catch'] })
    assert.deepEqual(rules(res), [])
    assert.match(res.suppressed[0].reason, /waived known slop/)
  } finally { r.done() }
})

test('negative: an expired memory waiver, or a high-severity one with no expiry, does not suppress', () => {
  for (const expires of [new Date(Date.now() - DAY).toISOString(), null]) {
    const r = repo()
    try {
      const fp = fingerprint(r)
      r.write('.jstack/memory/entries/20261025-0000-aaaaaa.json', waived('20261025-0000-aaaaaa', fp, expires))
      r.write('.jstack/unslop.json', { waivers: [{ fingerprint: fp, reason: 'forever', expires: null }] })
      r.commit('stale waivers on main')
      branchWithSlop(r)
      const res = scan({ repo: r.dir, base: 'main', ruleIds: ['conc.empty-catch'] })
      assert.deepEqual(rules(res), ['conc.empty-catch'], `expires=${expires}`)
      assert.equal(res.suppressed.length, 0)
    } finally { r.done() }
  }
})

test('negative: a waiver the branch adds for its own hit is ignored and reported as a high hit', () => {
  const r = repo()
  try {
    const fp = fingerprint(r)
    branchWithSlop(r)
    r.write('.jstack/memory/entries/20261025-0000-bbbbbb.json', waived('20261025-0000-bbbbbb', fp, new Date(Date.now() + DAY).toISOString()))
    r.commit('waive my own slop')
    const res = scan({ repo: r.dir, base: 'main', ruleIds: ['conc.empty-catch'] })
    assert.deepEqual(rules(res), ['conc.empty-catch', 'unslop.new-waiver'])
    assert.equal(res.candidates.find(c => c.rule === 'unslop.new-waiver').severity, 'high')
  } finally { r.done() }
})

test('negative: config the branch changes (rule off, path ignored) is not used, and the change is a high hit', () => {
  const r = repo()
  try {
    r.write('.jstack/unslop.json', { gate: { mode: 'warn' } }); r.commit('config on main')
    branchWithSlop(r)
    r.write('.jstack/unslop.json', { gate: { mode: 'off' }, rules: { 'conc.empty-catch': { mode: 'off' } }, paths: { ignore: ['src/**'] } })
    r.commit('quiet the scanner')
    const res = scan({ repo: r.dir, base: 'main', ruleIds: ['conc.empty-catch'] })
    assert.deepEqual(rules(res), ['conc.empty-catch', 'unslop.config-changed'])
    // --full has no base to trust, so it reads the working tree as before.
    assert.deepEqual(rules(scan({ repo: r.dir, full: 'src', ruleIds: ['conc.empty-catch'] })), [])
  } finally { r.done() }
})
