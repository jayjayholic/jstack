#!/usr/bin/env node
// Keeps each domain pack's SKILL.md in step with its checks.json: the block between the checks markers is rendered
// from the machine file (questions by tier, budgets, red flags, confirm recipes, verify steps, triggers), so the
// human text and the scanner never disagree. Everything outside the markers is hand-written.
//   node packs.mjs render     rewrite the generated block in every skills/eng-*/SKILL.md
//   node packs.mjs check      exit 1 when a block is stale (CI and tests)
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { SKILLS_DIR, loadPacks } from './rules.mjs'

const BEGIN = '<!-- checks:begin (generated from checks.json by tools/unslop/packs.mjs; edit checks.json, then render) -->'
const END = '<!-- checks:end -->'
const TIERS = [['S', 'MUST (asked at every tier)'], ['M', 'SHOULD (tier M and L)'], ['L', 'DEEP (tier L, with the pre-mortem)']]
const cell = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')

function detector(r) {
  if (r.engine === 'regex') return `static \`${r.id}\` (regex)`
  if (r.engine === 'script') return `static \`${r.id}\` (script ${r.script})`
  if (r.engine === 'eyes') return 'review agent (eyes)'
  if (r.engine === 'measure') return 'measurement'
  return `${r.engine}${r.fallback ? `, else ${r.fallback.engine}` : ''}`
}

function renderBlock(pack) {
  const out = [BEGIN, '']
  out.push('## Pre-flight questions', '')
  for (const [tier, label] of TIERS) {
    const qs = (pack.questions ?? []).filter(q => q.tier === tier)
    if (!qs.length) continue
    out.push(`**${label}**`, '')
    for (const q of qs) out.push(`- \`${q.id}\` ${q.text} _(answer as: ${q.produces ?? 'text'}; prevents: ${(q.prevents ?? []).join(', ') || '-'})_`)
    out.push('')
  }
  if (pack.budgets?.length) {
    out.push('## Budgets', '', 'Defaults with their source. The project file `.jstack/budgets.json` wins; `null` means the project sets it the first time a task touches it (pre-flight turns that into a measure-first task).', '')
    out.push('| key | default | unit | how measured | source |', '|---|---|---|---|---|')
    for (const b of pack.budgets) out.push(`| \`${b.key}\` | ${b.default ?? 'null'} | ${cell(b.unit)} | ${cell(b.measure)} | ${cell(b.source ?? '-')} |`)
    out.push('')
  }
  out.push('## Red flags', '', 'A red flag is a hypothesis. /unslop turns it into a finding only with evidence (see Confirm recipes).', '')
  out.push('| id | what it looks like | why it is slop | detector | severity |', '|---|---|---|---|---|')
  for (const r of pack.rules ?? []) out.push(`| \`${r.id}\` | ${cell(r.title)} | ${cell(r.why ?? '')} | ${detector(r)} | ${r.severity ?? 'medium'} |`)
  out.push('', '## Confirm recipes', '')
  for (const r of pack.rules ?? []) {
    const fp = r.knownFalsePositives?.length ? ` Known false positives: ${r.knownFalsePositives.join('; ')}.` : ''
    const sug = r.suggest ? ` Suggest: \`${r.suggest}\`.` : ''
    out.push(`- \`${r.id}\`: ${r.confirm ?? 'build a failing test or a measurement that shows the harm'}${r.fixHint ? ` Fix direction: ${r.fixHint}.` : ''}${sug}${fp}`)
  }
  if (pack.tactics?.length) {
    out.push('', '## Tactics to suggest', '', 'A finding or a pre-flight answer that matches the "when" names the tactic, its saving and its source. Suggest, never apply silently: the tactic still goes through the verify steps.', '')
    out.push('| id | tactic | when | saving | source |', '|---|---|---|---|---|')
    for (const t of pack.tactics) out.push(`| \`${t.id}\` | ${cell(t.tactic)} | ${cell(t.when)} | ${cell(t.saving ?? '-')} | ${cell(t.source ?? '-')} |`)
  }
  if (pack.verify?.length) {
    out.push('', '## Verification steps', '', 'Run in this order after the change; each line is a pass criterion.', '')
    pack.verify.forEach((v, i) => out.push(`${i + 1}. \`${v.id}\` ${v.text} _(${v.kind ?? 'check'}${v.tool ? `; ${v.tool}` : ''})_`))
  }
  const t = pack.triggers ?? {}
  out.push('', '## Triggers', '', `Loaded by \`tools/unslop/classify.mjs\` when the task says ${(t.taskWords ?? []).slice(0, 12).map(w => `"${w}"`).join(', ')}, or touches ${(t.paths ?? []).slice(0, 8).map(p => `\`${p}\``).join(', ')}.`, '', END)
  return out.join('\n')
}

function applyBlock(text, block) {
  const a = text.indexOf('<!-- checks:begin')
  const b = text.indexOf(END)
  if (a < 0 || b < 0) return null
  return text.slice(0, a) + block + text.slice(b + END.length)
}

function each(fn, skillsDir = SKILLS_DIR) {
  return loadPacks(skillsDir).map(p => {
    const file = path.join(p.dir, 'SKILL.md')
    let text = null
    try { text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') } catch {
      return { skill: p.skill, file, problem: 'SKILL.md missing' }
    }
    const next = applyBlock(text, renderBlock(p))
    if (next === null) return { skill: p.skill, file, problem: 'checks markers missing' }
    return fn({ pack: p, file, text, next })
  })
}

function main(argv) {
  const cmd = argv[0] ?? 'check'
  if (cmd === 'render') {
    const res = each(({ file, text, next, pack }) => { if (next !== text) fs.writeFileSync(file, next); return { skill: pack.skill, changed: next !== text } })
    for (const r of res) console.log(`${r.skill}: ${r.problem ?? (r.changed ? 'rendered' : 'up to date')}`)
    return res.some(r => r.problem) ? 1 : 0
  }
  if (cmd === 'check') {
    const res = each(({ text, next, pack }) => ({ skill: pack.skill, stale: next !== text }))
    const bad = res.filter(r => r.problem || r.stale)
    for (const r of bad) console.log(`${r.skill}: ${r.problem ?? 'generated block is stale; run node tools/unslop/packs.mjs render'}`)
    if (!bad.length) console.log(`${res.length} pack(s) in step with checks.json`)
    return bad.length ? 1 : 0
  }
  console.log('usage: packs.mjs render|check')
  return 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)))

export { renderBlock, applyBlock, BEGIN, END }
