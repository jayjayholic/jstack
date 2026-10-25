// node --test tools/unslop/adapters.test.mjs
// The tools are faked through the exec hook, so these run on machines without semgrep or ast-grep.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseSemgrep, parseAstGrep, runAdapter, semgrepConfig } from './adapters.mjs'
import { scan } from './scan.mjs'

const files = [{ path: 'src/a.ts', text: 'one\ntwo\nthree\nfour\n', added: new Set([3]) }, { path: 'src/b.ts', text: 'x\n', added: null }]
const ctx = { files, base: os.tmpdir() }
const all = () => true

// A fake tool: answers --version when installed, and returns `out` for the scan call.
const fake = (installed, out) => {
  const calls = []
  const exec = (cmd, args) => { calls.push([cmd, ...args]); if (args[0] === '--version') return installed ? { status: 0, stdout: '1.0' } : { status: null, error: new Error('ENOENT') }; return { status: 1, stdout: out } }
  return { exec, calls }
}

const SEMGREP_OUT = JSON.stringify({ results: [
  { path: 'src/a.ts', start: { line: 3 }, end: { line: 3 }, extra: { lines: 'three' } },
  { path: 'src/a.ts', start: { line: 1 }, end: { line: 1 }, extra: { lines: 'one' } },
  { path: 'src/b.ts', start: { line: 1 }, end: { line: 1 }, extra: { lines: 'x' } },
  { path: 'elsewhere.ts', start: { line: 1 }, end: { line: 1 }, extra: { lines: 'y' } },
] })

test('semgrep: hits on added lines (and in new files) come back with their snippet; the rule goes in as JSON config', () => {
  const f = fake(true, SEMGREP_OUT)
  const r = runAdapter({ id: 'x.sg', engine: 'semgrep', semgrep: { pattern: 'foo(...)', languages: ['typescript'] } }, ctx, all, { exec: f.exec })
  assert.deepEqual(r.hits.map(h => `${h.path}:${h.line}`), ['src/a.ts:3', 'src/b.ts:1'])
  const call = f.calls.find(c => c[1] === '--config')
  assert.ok(call.includes('--') && call.at(-1) === 'src/b.ts', 'paths come after --, never as options')
  assert.deepEqual(semgrepConfig({ id: 'x', semgrep: { pattern: 'p', languages: ['ts'] } }).rules[0].pattern, 'p')
})

test('ast-grep: 0-based lines are converted, and scope "file" keeps hits outside the added lines', () => {
  const out = JSON.stringify([{ file: 'src/a.ts', range: { start: { line: 0 }, end: { line: 0 } }, lines: 'one' }, { file: 'src/a.ts', range: { start: { line: 2 }, end: { line: 2 } }, lines: 'three' }])
  const added = runAdapter({ id: 'x.ag', engine: 'ast-grep', astGrep: { pattern: '$A', language: 'ts' } }, ctx, all, { exec: fake(true, out).exec })
  assert.deepEqual(added.hits.map(h => h.line), [3])
  const whole = runAdapter({ id: 'x.ag', engine: 'ast-grep', scope: 'file', astGrep: { pattern: '$A', language: 'ts' } }, ctx, all, { exec: fake(true, out).exec })
  assert.deepEqual(whole.hits.map(h => h.line), [1, 3])
})

test('negative: a missing tool, a rule with no pattern or unreadable output are "not checked", never a pass', () => {
  assert.match(runAdapter({ id: 'x', engine: 'semgrep', semgrep: { pattern: 'p' } }, ctx, all, { exec: fake(false).exec }).notChecked, /semgrep is not installed/)
  assert.match(runAdapter({ id: 'x', engine: 'ast-grep', astGrep: { pattern: 'p', language: 'ts' } }, ctx, all, { exec: fake(false).exec }).notChecked, /ast-grep is not installed/)
  assert.match(runAdapter({ id: 'x', engine: 'semgrep', semgrep: {} }, ctx, all, { exec: fake(true, '').exec }).notChecked, /no semgrep pattern/)
  assert.match(runAdapter({ id: 'x', engine: 'ast-grep', astGrep: { pattern: 'p' } }, ctx, all, { exec: fake(true, '').exec }).notChecked, /language/)
  assert.match(runAdapter({ id: 'x', engine: 'semgrep', semgrep: { pattern: 'p' } }, ctx, all, { exec: fake(true, 'Traceback...').exec }).notChecked, /unreadable/)
})

test('negative: parsers reject garbage and drop rows without a line', () => {
  assert.equal(parseSemgrep('nope'), null)
  assert.equal(parseSemgrep('{"errors":[]}'), null)
  assert.deepEqual(parseSemgrep('{"results":[{"path":"a","start":{}}]}'), [])
  assert.equal(parseAstGrep('{"not":"an array"}'), null)
  assert.deepEqual(parseAstGrep('[{"file":"a"}]'), [])
})

test('scan: a semgrep rule with a fallback uses it when the tool is absent; without one it is listed as not checked', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unslop-adapt-'))
  try {
    fs.writeFileSync(path.join(root, 'a.ts'), 'eval(input)\n')
    const absent = { exec: fake(false).exec }
    const withFallback = scan({ root, adapterOptions: absent, rules: [{ id: 'x.eval', domain: 'security', engine: 'semgrep', semgrep: { pattern: 'eval(...)' }, fallback: { engine: 'regex', pattern: '\\beval\\(' } }] })
    assert.deepEqual(withFallback.candidates.map(c => c.line), [1])
    const without = scan({ root, adapterOptions: absent, rules: [{ id: 'x.eval', domain: 'security', engine: 'semgrep', semgrep: { pattern: 'eval(...)' } }] })
    assert.equal(without.candidates.length, 0)
    assert.match(without.notChecked[0].reason, /not installed/)
    const present = scan({ root, adapterOptions: { exec: fake(true, JSON.stringify({ results: [{ path: 'a.ts', start: { line: 1 }, end: { line: 1 }, extra: { lines: 'eval(input)' } }] })).exec }, rules: [{ id: 'x.eval', domain: 'security', engine: 'semgrep', semgrep: { pattern: 'eval(...)' } }] })
    assert.equal(present.candidates[0].rule, 'x.eval')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
