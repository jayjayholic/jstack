#!/usr/bin/env node
// Fast mode for ready-gate.sh and the train: static rules on the lines this branch added, plus the project memory
// check, in under JSTACK_UNSLOP_GATE_SECONDS (default 60). No agents, no measure rules. It blocks only when the
// project config says "block" AND the hit's rule earned block-when-confirmed (field precision, see SELF-EVAL.md)
// AND its severity is in gate.blockSeverities; everything else is printed as a warning.
//   node gate.mjs --base origin/main [--repo .] [--mode warn|block|off] [--json]
//   node gate.mjs --train [--repo .]     merged-tree rules on the whole tree: conflict markers, catalog keys lost
//                                         in a merge, duplicate migration stamps. Any hit exits 1 (drop the branch).
// Exit 0 pass, 1 blocked, 2 usage error. A rule whose engine is missing prints "not checked", never a pass.
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scan } from './scan.mjs'
import { loadProjectConfig } from './rules.mjs'

const TRAIN_RULES = ['ci.conflict-marker', 'i18n.catalog-parity', 'data.migration-stamp-dup']
const HERE = path.dirname(fileURLToPath(import.meta.url))

function memoryCheck(repo, base) {
  const r = spawnSync(process.execPath, [path.join(HERE, '..', 'memory', 'memory.mjs'), 'check', '--changed', '--base', base, '--repo', repo], { cwd: repo, encoding: 'utf8' })
  return { exit: r.status ?? 1, out: (r.stdout ?? '') + (r.stderr ?? '') }
}

function gate({ repo = process.cwd(), base = 'origin/main', mode = null, train = false, memory = true } = {}) {
  const project = loadProjectConfig(repo)
  const cfg = project?.gate ?? {}
  const effMode = mode ?? process.env.JSTACK_READY_UNSLOP ?? cfg.mode ?? 'warn'
  if (effMode === 'off') return { exit: 0, lines: ['unslop gate: off'] }
  const maxMs = Number(process.env.JSTACK_UNSLOP_GATE_SECONDS ?? cfg.maxSeconds ?? 60) * 1000
  const blockSev = new Set(cfg.blockSeverities ?? ['high'])
  const res = train
    ? scan({ repo, full: '.', ruleIds: TRAIN_RULES })
    : scan({ repo, base, domains: null })
  const lines = []
  let blocked = 0
  const hints = res.candidates.filter(c => c.mode === 'eyes-hint' && !train)
  for (const c of res.candidates.filter(c => !hints.includes(c))) {
    const blocks = train || (effMode === 'block' && c.mode === 'block-when-confirmed' && blockSev.has(c.severity))
    if (blocks) blocked++
    lines.push(`${blocks ? 'BLOCK' : 'warn '} ${c.rule}  ${c.path}:${c.line}  ${c.title}${c.detail ? ` (${c.detail})` : ''}`)
  }
  for (const n of res.notChecked) lines.push(`----  ${n.rule}  ${n.reason}`)
  let memExit = 0
  if (!train && memory && project) {
    const m = memoryCheck(repo, base)
    memExit = m.exit
    if (m.exit !== 0) lines.push(...m.out.trim().split('\n').map(l => `memory ${l}`))
  }
  const memMode = process.env.JSTACK_READY_MEMORY ?? 'block'
  if (memExit !== 0 && memMode === 'block') blocked++
  if (res.ms > maxMs) lines.push(`warn  gate took ${res.ms} ms, over its ${maxMs} ms budget: narrow the rules or the diff`)
  lines.push(`unslop gate (${train ? 'train, merged tree' : effMode}): ${res.candidates.length - hints.length} hit(s), ${blocked} blocking, ${hints.length} eyes-hint (left to /unslop review agents), ${res.suppressed.length} suppressed, ${res.files} file(s), ${res.ms} ms`)
  return { exit: blocked ? 1 : 0, lines, res }
}

function main(argv) {
  const get = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }
  const r = gate({ repo: path.resolve(get('--repo') ?? '.'), base: get('--base') ?? 'origin/main', mode: get('--mode') ?? null, train: argv.includes('--train'), memory: !argv.includes('--no-memory') })
  if (argv.includes('--json')) process.stdout.write(JSON.stringify({ exit: r.exit, lines: r.lines, candidates: r.res?.candidates ?? [] }, null, 2) + '\n')
  else process.stdout.write(r.lines.join('\n') + '\n')
  return r.exit
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)))

export { gate, TRAIN_RULES }
