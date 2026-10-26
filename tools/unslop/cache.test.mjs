// node --test tools/unslop/cache.test.mjs
// Prompt-cache red flags: the static rules' precision on fixtures and decoys, and cache-probe's verdicts from usage.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { selftest } from './selftest.mjs'
import { topLevelCacheControl } from './scripts.mjs'
import { normalize, replay, usageReport, breakEven, main } from './cache-probe.mjs'
import { loadRules } from './rules.mjs'
import { regexHits } from './scan.mjs'

const CACHE_RULES = ['cost.cache-top-level', 'cost.volatile-system-prompt', 'cost.tools-from-set']

test('precision: the cache rules have no false positive or miss on dev and holdout, and are not overfit', () => {
  const res = selftest({ sets: ['dev', 'holdout'], ruleIds: CACHE_RULES })
  for (const set of ['dev', 'holdout']) {
    const rules = res.sets[set].rules
    assert.deepEqual(rules.map(r => r.rule).sort(), [...CACHE_RULES].sort(), `${set} covers every cache rule`)
    for (const r of rules) assert.deepEqual({ rule: r.rule, fp: r.fp, fn: r.fn }, { rule: r.rule, fp: 0, fn: 0 }, `${set} ${JSON.stringify(r.failed)}`)
  }
  assert.deepEqual(res.coverage, [])
  assert.deepEqual(res.overfit, [])
})

test('cache-top-level decoys: comments, strings, other APIs and nested objects stay silent', () => {
  const decoys = [
    "client.messages.create({ model, // cache_control: { type: 'ephemeral' }\n messages })",
    "client.messages.create({ model, system: 'use cache_control: on blocks', messages })",
    "const { messages, cache_control } = req",
    "const send = ({ messages, cache_control }) => post(messages)",
    "type Req = { messages: Message[]; cache_control?: Mark }",
    "client.messages.create({ model, metadata: { cache_control: 'x' }, messages })",
    "client.messages.create(buildParams({ cache_control: { type: 'ephemeral' } }))",
    '/* client.messages.create({ cache_control: {} }) */ const x = 1',
  ]
  for (const d of decoys) assert.deepEqual(topLevelCacheControl(d, false), [], d)
  assert.deepEqual(topLevelCacheControl('client.messages.create(model=m, extra={"cache_control": 1}, # cache_control=x\n messages=m)', true), [])
})

test('cache-top-level: a request object built apart from the call (JS and Python dict) is found', () => {
  const lineOf = (t, at) => t.slice(0, at).split('\n').length
  const js = "const request = {\n  model,\n  messages: turns,\n  cache_control: { type: 'ephemeral' },\n}\nawait client.messages.create(request)\n"
  assert.equal(lineOf(js, topLevelCacheControl(js, false)[0]), 4)
  const py = 'request = {\n    "max_tokens": n,\n    "messages": conversation,\n    "cache_control": {"type": "ephemeral"},\n}\n'
  assert.equal(lineOf(py, topLevelCacheControl(py, true)[0]), 4)
})

test('cache-top-level: shorthand and a second call in the same file are found', () => {
  const text = "a.messages.create({ model, messages })\nb.messages.create({ model, cache_control, messages })\n"
  const hits = topLevelCacheControl(text, false)
  assert.equal(hits.length, 1)
  assert.equal(text.slice(0, hits[0]).split('\n').length, 2)
})

test('volatile-system-prompt: a multi-line system template with the clock fires at its first line, a ternary does not', () => {
  const rule = loadRules({ repo: null, ruleIds: ['cost.volatile-system-prompt'] })[0]
  const slop = { path: 'a.ts', text: 'const systemPrompt = `Rules:\n- be brief\nToday: ${new Date().toDateString()}`\n', added: null }
  assert.deepEqual(regexHits(rule, slop).map(h => h.line), [1])
  const clean = { path: 'a.ts', text: 'const system = flag ? A : B\nconst user = `at ${Date.now()}`\n', added: null }
  assert.deepEqual(regexHits(rule, clean), [])
})

test('normalize reads Anthropic, OpenAI and OpenTelemetry usage', () => {
  assert.deepEqual(normalize({ usage: { input_tokens: 248, cache_read_input_tokens: 1800, cache_creation_input_tokens: 100, cache_creation: { ephemeral_1h_input_tokens: 40, ephemeral_5m_input_tokens: 60 } } }), { uncached: 248, read: 1800, write: 100, write1h: 40, total: 2148 })
  assert.deepEqual(normalize({ prompt_tokens: 2000, prompt_tokens_details: { cached_tokens: 1500 } }), { uncached: 500, read: 1500, write: 0, write1h: 0, total: 2000 })
  assert.deepEqual(normalize({ input_tokens: 2000, input_tokens_details: { cached_tokens: 1024 }, cache_write_tokens: 500 }), { uncached: 476, read: 1024, write: 500, write1h: 0, total: 2000 })
  assert.deepEqual(normalize({ 'gen_ai.usage.input_tokens': 2048, 'gen_ai.usage.cache_read.input_tokens': 1800 }), { uncached: 248, read: 1800, write: 0, write1h: 0, total: 2048 })
})

test('replay: a second call that reads the prefix is ok', () => {
  const r = replay({ input_tokens: 20, cache_creation_input_tokens: 3000 }, { input_tokens: 20, cache_read_input_tokens: 3000 })
  assert.equal(r.verdict, 'ok')
  assert.equal(r.missPct, 0.7)
})

test('negative: replay flags write-only, not-cached and a prefix that moved', () => {
  assert.equal(replay({ input_tokens: 5, cache_creation_input_tokens: 2741 }, { input_tokens: 5, cache_creation_input_tokens: 2741 }).verdict, 'write-only')
  assert.equal(replay({ input_tokens: 400 }, { input_tokens: 400 }).verdict, 'not-cached')
  const moved = replay({ input_tokens: 4, cache_creation_input_tokens: 30000 }, { input_tokens: 4, cache_read_input_tokens: 11000, cache_creation_input_tokens: 19000 })
  assert.equal(moved.verdict, 'prefix-moved')
  assert.ok(moved.missPct > 50)
})

test('breakEven: 5-minute writes need 0.28 reads per written token, 1-hour writes 1.11', () => {
  assert.equal(breakEven(100, 0), 0.28)
  assert.equal(breakEven(100, 100), 1.11)
  assert.equal(breakEven(0, 0), 0)
})

test('usageReport: per site hit, reads per write against break-even, and gaps over the TTL', () => {
  const t = m => new Date(Date.UTC(2026, 0, 1, 0, m)).toISOString()
  const rows = [
    { site: 'loop', at: t(0), input_tokens: 10, cache_creation_input_tokens: 5000 },
    { site: 'loop', at: t(1), input_tokens: 10, cache_read_input_tokens: 5000, cache_creation_input_tokens: 300 },
    { site: 'loop', at: t(2), input_tokens: 10, cache_read_input_tokens: 5300, cache_creation_input_tokens: 300 },
    { site: 'per-doc', at: t(0), input_tokens: 3, cache_creation_input_tokens: 1200 },
    { site: 'per-doc', at: t(90), input_tokens: 3, cache_creation_input_tokens: 1100 },
    { site: 'tiny', at: t(0), input_tokens: 300 },
  ]
  const by = Object.fromEntries(usageReport(rows, { minHitPct: 60 }).map(r => [r.site, r]))
  assert.equal(by.loop.verdict, 'ok')
  assert.ok(by.loop.hitPct > 60)
  assert.equal(by['per-doc'].verdict, 'write-only')
  assert.equal(by['per-doc'].gapsOverTtlPct, 100)
  assert.equal(by.tiny.verdict, 'not-cached')
})

test('cli: replay exits 1 on write-only and prints the value evidence.mjs reads', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-probe-'))
  try {
    const a = path.join(dir, 'a.json'), b = path.join(dir, 'b.json')
    fs.writeFileSync(a, JSON.stringify({ usage: { input_tokens: 5, cache_creation_input_tokens: 2741 } }))
    fs.writeFileSync(b, JSON.stringify({ usage: { input_tokens: 5, cache_creation_input_tokens: 2741 } }))
    const out = []
    const write = process.stdout.write
    process.stdout.write = s => { out.push(String(s)); return true }
    let code
    try { code = main(['replay', a, b]) } finally { process.stdout.write = write }
    assert.equal(code, 1)
    assert.match(out.join(''), /verdict=write-only miss_pct=100/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
