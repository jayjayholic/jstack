// node --test tools/unslop/prompting.test.mjs
// Prompt layout, batch and cache-parameter red flags: precision of the static rules on fixtures and decoys, every
// rule's suggested tactic resolving to a sourced pack tactic, and prompt-ab's verdicts for a prompt change and a judge.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { selftest } from './selftest.mjs'
import { loadPacks, loadRules, tacticById } from './rules.mjs'
import { regexHits, scan } from './scan.mjs'
import { suggestionOf } from './report.mjs'
import { renderBlock } from './packs.mjs'
import { compare, judge, main } from './prompt-ab.mjs'
import { packDigest } from '../../hooks/jstack-preflight.mjs'

const RULES = ['cost.cache-param-varies', 'cost.batchable-sync-job', 'cost.clock-before-breakpoint', 'prompt.question-before-docs', 'prompt.prefill-last-turn', 'prompt.shuffled-examples']
const OFFICIAL = /^https:\/\/(?:platform\.claude\.com\/docs\/|docs\.claude\.com\/|www\.anthropic\.com\/engineering\/)/
const rule = id => loadRules({ repo: null, ruleIds: [id] })[0]
const lines = (id, file, text) => regexHits(rule(id), { path: file, text, added: null }).map(h => h.line)

test('precision: the new rules have no false positive or miss on dev and holdout, and are not overfit', () => {
  const res = selftest({ sets: ['dev', 'holdout'], ruleIds: RULES })
  for (const set of ['dev', 'holdout']) {
    const rules = res.sets[set].rules
    assert.deepEqual(rules.map(r => r.rule).sort(), [...RULES].sort(), `${set} covers every new rule`)
    for (const r of rules) assert.deepEqual({ rule: r.rule, fp: r.fp, fn: r.fn }, { rule: r.rule, fp: 0, fn: 0 }, `${set} ${JSON.stringify(r.failed)}`)
  }
  assert.deepEqual(res.coverage, [])
  assert.deepEqual(res.overfit, [])
})

test('cache-param-varies decoys: optional types, comparisons and files without a model call stay silent', () => {
  const call = 'client.messages.create({ max_tokens: 1, messages })\n'
  assert.deepEqual(lines('cost.cache-param-varies', 'a.ts', call + 'type Req = { thinking?: Config; effort?: Level }\n'), [])
  assert.deepEqual(lines('cost.cache-param-varies', 'a.ts', call + "const effort: Level = opts.effort ?? 'low'\n"), [])
  assert.deepEqual(lines('cost.cache-param-varies', 'a.py', 'client.messages.create(max_tokens=1)\nif tool_choice == "any":\n    pass\n'), [])
  assert.deepEqual(lines('cost.cache-param-varies', 'ui.ts', "const s = { effort: hard ? 'high' : 'low' }\n"), [])
  assert.deepEqual(lines('cost.cache-param-varies', 'a.ts', call + "const req = { tool_choice: force ? { type: 'any' } : undefined }\n"), [2])
})

test('batchable-sync-job: only job paths, and a batch or a stream anywhere in the file silences it', () => {
  const call = "await llm.messages.create({ model, max_tokens: 9, messages })\n"
  const hit = (p, text) => scan({ root: tmpRepo({ [p]: text }), rules: [rule('cost.batchable-sync-job')] }).candidates.length
  assert.equal(hit('src/cron/digest.ts', call), 1)
  assert.equal(hit('src/lib/digest.ts', call), 0)
  assert.equal(hit('src/cron/digest.ts', call + 'const b = llm.messages.batches\n'), 0)
  assert.equal(hit('src/cron/digest.ts', "await llm.messages.create({ model, max_tokens: 9, messages, stream: true })\n"), 0)
})

test('clock-before-breakpoint decoys: the time in the next block or a stable date constant stays silent', () => {
  const next = "[{ type: 'text', text: RULES, cache_control: { type: 'ephemeral' } }, { type: 'text', text: `${new Date().toISOString()}` }]\n"
  assert.deepEqual(lines('cost.clock-before-breakpoint', 'a.ts', next), [])
  assert.deepEqual(lines('cost.clock-before-breakpoint', 'a.ts', "{ type: 'text', text: `${RULES} as of ${RELEASE_DATE}`, cache_control: { type: 'ephemeral' } }\n"), [])
  assert.deepEqual(lines('cost.clock-before-breakpoint', 'a.ts', "{\n  cache_control: { type: 'ephemeral' },\n  text: `Now ${Date.now()}`,\n}\n"), [2])
})

test('question-before-docs decoys: a question after the documents, other variable names and plain strings stay silent', () => {
  assert.deepEqual(lines('prompt.question-before-docs', 'a.ts', 'const p = `${documents}\\n\\n${question}`\n'), [])
  assert.deepEqual(lines('prompt.question-before-docs', 'a.ts', "const p = 'Q: ${question} docs ${documents}'\n"), [])
  assert.deepEqual(lines('prompt.question-before-docs', 'a.ts', 'const a = `${title}`\nconst b = `${context}`\n'), [])
  assert.deepEqual(lines('prompt.question-before-docs', 'a.ts', 'const p = `Q: ${query}\\n<documents>${chunks}</documents>`\n'), [1])
})

test('prefill-last-turn decoys: an assistant turn from a variable or one in the middle stays silent', () => {
  assert.deepEqual(lines('prompt.prefill-last-turn', 'a.ts', "const m = [{ role: 'assistant', content: prior }]\n"), [])
  assert.deepEqual(lines('prompt.prefill-last-turn', 'a.ts', "const m = [{ role: 'assistant', content: 'hi' }, { role: 'user', content: q }]\n"), [])
  assert.deepEqual(lines('prompt.prefill-last-turn', 'a.ts', "const m = [{ role: 'user', content: q }, { role: 'assistant', content: '[' }]\n"), [1])
})

test('shuffled-examples decoys: a deterministic sort and other shuffled lists stay silent', () => {
  assert.deepEqual(lines('prompt.shuffled-examples', 'a.ts', 'const s = examples.sort((a, b) => a.id - b.id)\n'), [])
  assert.deepEqual(lines('prompt.shuffled-examples', 'a.py', 'random.shuffle(cases)\n'), [])
  assert.deepEqual(lines('prompt.shuffled-examples', 'a.py', 'shots = random.choices(examples, k=3)\n'), [1])
})

test('every suggest names a tactic of its pack, and every tactic cites an official source', () => {
  const packs = loadPacks().filter(p => ['llm-cost', 'llm-prompting'].includes(p.domain))
  assert.equal(packs.length, 2)
  for (const p of packs) {
    assert.ok(p.tactics.length >= 10, `${p.domain} tactics`)
    const ids = new Set(p.tactics.map(t => t.id))
    for (const t of p.tactics) {
      for (const k of ['id', 'tactic', 'when', 'saving', 'source']) assert.ok(t[k], `${t.id} lacks ${k}`)
      assert.match(t.source, OFFICIAL, `${t.id} source`)
    }
    for (const r of p.rules) if (r.suggest) assert.ok(ids.has(r.suggest), `${r.id} -> ${r.suggest}`)
    for (const id of RULES.filter(id => id.startsWith(p.rules[0].id.split('.')[0] + '.'))) assert.ok(p.rules.find(r => r.id === id).suggest, `${id} suggests nothing`)
  }
})

test('a static candidate carries its tactic, and the report line names the tactic, the saving and the source', () => {
  const root = tmpRepo({ 'jobs/nightly.ts': "await llm.messages.create({ model, max_tokens: 9, messages })\n" })
  const [c] = scan({ root, rules: [rule('cost.batchable-sync-job')] }).candidates
  assert.equal(c.suggest.id, 'cost.t.batches')
  assert.match(c.suggest.saving, /-50%/)
  assert.match(c.suggest.source, /batch-processing/)
  assert.equal(suggestionOf(c), c.suggest)
  assert.equal(suggestionOf({ suggest: 'prompt.t.no-prefill' }).id, 'prompt.t.no-prefill')
  assert.equal(suggestionOf({ suggest: 'nope.t.x' }), null)
  assert.equal(suggestionOf({}), null)
  assert.equal(tacticById('cost.t.date-after-breakpoint').source.endsWith('/prompt-caching'), true)
})

test('rendered packs: a Tactics section only where the pack has tactics; the pre-flight digest lists them', () => {
  const [cost] = loadPacks().filter(p => p.domain === 'llm-cost')
  const [sec] = loadPacks().filter(p => p.domain === 'security')
  assert.match(renderBlock(cost), /## Tactics to suggest/)
  assert.match(renderBlock(cost), /Suggest: `cost\.t\.batches`/)
  assert.doesNotMatch(renderBlock(sec), /Tactics to suggest/)
  assert.match(packDigest(['llm-prompting'], 'M'), /tactics to suggest/)
  assert.doesNotMatch(packDigest(['security'], 'M'), /tactics to suggest/)
})

const rows = (scores, prefix = 'c') => scores.map((s, i) => ({ case: `${prefix}${i}`, score: s }))

test('prompt-ab compare: same quality is ok, a real drop is regressed, a clear gain says better', () => {
  const base = Array.from({ length: 60 }, (_, i) => (i % 4 === 0 ? 0 : 1))
  assert.equal(compare(rows(base), rows(base)).verdict, 'ok')
  const worse = base.map((s, i) => (i % 3 === 0 ? 0 : s))
  const r = compare(rows(base), rows(worse))
  assert.equal(r.verdict, 'regressed')
  assert.ok(r.diff_pp < -10 && r.ci_pp[0] < -2)
  const better = compare(rows(base.map(() => 0.5)), rows(base.map(() => 0.9)))
  assert.equal(better.verdict, 'ok')
  assert.equal(better.better, true)
})

test('negative: prompt-ab compare refuses too few cases and arms that ran different cases', () => {
  assert.equal(compare(rows([1, 1, 0]), rows([1, 1, 0])).verdict, 'too-few')
  const a = rows(Array(60).fill(1))
  const b = rows(Array(60).fill(1)).map((r, i) => (i === 0 ? { ...r, case: 'other' } : r))
  const m = compare(a, b)
  assert.equal(m.verdict, 'mismatched')
  assert.equal(m.missing, 2)
})

test('prompt-ab judge: agreement and kappa; a judge that always says pass is uncalibrated', () => {
  const human = Array.from({ length: 40 }, (_, i) => ({ case: `c${i}`, label: i % 2 ? 'pass' : 'fail' }))
  const good = judge(human, human.map((r, i) => (i === 0 ? { ...r, label: 'pass' } : r)))
  assert.equal(good.verdict, 'ok')
  assert.ok(good.agreement >= 0.97 && good.kappa > 0.9)
  const lazy = judge(human, human.map(r => ({ ...r, label: 'pass' })))
  assert.equal(lazy.verdict, 'uncalibrated')
  assert.equal(lazy.kappa, 0)
  assert.equal(judge(human.slice(0, 5), human.slice(0, 5)).verdict, 'too-few')
})

test('prompt-ab CLI: exit 0 on ok, 1 on a regression, 2 on bad usage', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-ab-'))
  try {
    const w = (n, r) => { const f = path.join(dir, n); fs.writeFileSync(f, r.map(x => JSON.stringify(x)).join('\n')); return f }
    const base = Array.from({ length: 60 }, (_, i) => (i % 5 ? 1 : 0))
    const log = console.log
    console.log = () => {}
    try {
      assert.equal(main(['compare', w('a.jsonl', rows(base)), w('b.jsonl', rows(base))]), 0)
      assert.equal(main(['compare', w('a.jsonl', rows(base)), w('c.jsonl', rows(base.map(() => 0)))]), 1)
      assert.equal(main(['nope']), 2)
    } finally { console.log = log }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

function tmpRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prompting-'))
  for (const [p, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true })
    fs.writeFileSync(path.join(root, p), text)
  }
  test.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}
