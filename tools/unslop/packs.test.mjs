import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { loadPacks, JSTACK_ROOT, SKILLS_DIR } from './rules.mjs'
import { renderBlock, applyBlock } from './packs.mjs'

const packs = loadPacks()
const ENGINES = new Set(['regex', 'script', 'eyes', 'measure', 'eslint', 'ast-grep', 'semgrep'])
const SEVERITIES = new Set(['high', 'medium', 'low'])
const MODES = new Set(['warn', 'block-when-confirmed', 'eyes-hint', undefined])

test('there are 16 domain packs and each has SKILL.md, SOURCES.md and checks.json', () => {
  assert.equal(packs.length, 16)
  for (const p of packs) {
    for (const f of ['SKILL.md', 'SOURCES.md', 'checks.json']) assert.ok(fs.existsSync(path.join(p.dir, f)), `${p.skill}/${f}`)
    const src = fs.readFileSync(path.join(p.dir, 'SOURCES.md'), 'utf8')
    assert.ok(src.split('\n').filter(l => l.startsWith('- ')).length >= 5, `${p.skill} has too few sources`)
  }
})

test('every rule, question and verify step is well formed, and ids are unique across packs', () => {
  const ids = new Set()
  for (const p of packs) {
    const prefix = p.rules[0].id.split('.')[0]
    for (const r of p.rules) {
      assert.ok(!ids.has(r.id), `duplicate id ${r.id}`); ids.add(r.id)
      assert.ok(r.id.startsWith(prefix + '.'), `${r.id} prefix`)
      assert.ok(ENGINES.has(r.engine), `${r.id} engine ${r.engine}`)
      assert.ok(SEVERITIES.has(r.severity), `${r.id} severity`)
      assert.ok(MODES.has(r.mode), `${r.id} mode ${r.mode}`)
      for (const k of ['title', 'why', 'confirm', 'failureClass']) assert.ok(r[k], `${r.id} lacks ${k}`)
      for (const k of ['pattern', 'unless', 'ifFile', 'unlessFile']) if (r[k]) assert.doesNotThrow(() => new RegExp(r[k], (r.flags ?? '').replace(/[gm]/g, '')), `${r.id}.${k}`)
      if (r.engine === 'regex') assert.ok(r.pattern, `${r.id} pattern`)
    }
    for (const q of p.questions) {
      assert.ok(!ids.has(q.id), `duplicate id ${q.id}`); ids.add(q.id)
      assert.ok(['S', 'M', 'L'].includes(q.tier), `${q.id} tier`)
      assert.ok(q.text.length > 10)
    }
    assert.ok(p.questions.some(q => q.tier === 'S'), `${p.skill} has no MUST question`)
    for (const v of p.verify ?? []) { assert.ok(!ids.has(v.id), `duplicate id ${v.id}`); ids.add(v.id) }
    for (const b of p.budgets ?? []) assert.ok(b.key && b.measure, `${p.skill} budget ${b.key} needs a measure`)
  }
})

test('negative: a stale generated block or missing markers is detected', () => {
  const p = packs[0]
  const block = renderBlock(p)
  assert.equal(applyBlock('no markers here', block), null)
  const text = fs.readFileSync(path.join(p.dir, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n')
  const stale = text.replace(p.questions[0].text, 'an edited question')
  assert.notEqual(applyBlock(stale, block), stale)
})

test('every SKILL.md is in step with its checks.json (packs.mjs check)', () => {
  const r = spawnSync(process.execPath, [path.join(JSTACK_ROOT, 'tools', 'unslop', 'packs.mjs'), 'check'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

test('skill frontmatter: name matches the folder, description says when to use and stays short', () => {
  for (const dir of [...packs.map(p => p.skill), 'preflight', 'unslop']) {
    const text = fs.readFileSync(path.join(SKILLS_DIR, dir, 'SKILL.md'), 'utf8')
    const m = /^---\nname: (.+)\ndescription: "(.+)"\n---/.exec(text.replace(/\r\n/g, '\n'))
    assert.ok(m, `${dir} frontmatter`)
    assert.equal(m[1], dir)
    assert.match(m[2], /^Use /)
    assert.ok(m[2].length <= 400, `${dir} description is ${m[2].length} chars`)
  }
})

test('negative: no product, person or private names leak into the generic kit', () => {
  const BANNED = /hakutaku|yokai|nekomata|cartographer|\bjev\b|typesafe|agent lab|night dream|composio|nango|qstash|supabase|zenstack|graphiti|\bbrain\b|joão|\bjoao\b/i
  const dirs = [...packs.map(p => p.dir), path.join(SKILLS_DIR, 'preflight'), path.join(SKILLS_DIR, 'unslop'), path.join(JSTACK_ROOT, 'tools', 'unslop'), path.join(JSTACK_ROOT, 'tools', 'memory')]
  const hits = []
  const visit = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name)
      if (e.isDirectory()) visit(f)
      else if (/\.(md|json|mjs)$/.test(e.name) && !e.name.endsWith('.test.mjs')) {
        fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => { if (BANNED.test(l)) hits.push(`${path.relative(JSTACK_ROOT, f)}:${i + 1}`) })
      }
    }
  }
  dirs.forEach(visit)
  assert.deepEqual(hits, [])
})
