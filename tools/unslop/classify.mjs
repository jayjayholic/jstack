#!/usr/bin/env node
// Picks the domain packs a task touches: task words, planned or touched paths, diff tokens and project memory, each
// hit named as a reason. Prints a tier hint (S/M/L) from the risk words it saw; /preflight decides the tier with
// RISK.md, this only proposes it. A domain needs score >= 2 (two task words, or one path, or one memory entry);
// single weak hits are listed so the agent can add the domain with a reason.
//   node classify.mjs --task "<ask>" [--paths a,b] [--base <ref>] [--repo <dir>] [--json]
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { loadPacks, matchAny, loadProjectConfig, ignoreGlobs } from './rules.mjs'

const COMPANIONS = ['eval-testing']
const RISK_WORDS = {
  irreversibility: ['migration', 'migrate', 'delete', 'drop', 'deploy', 'release', 'send', 'email', 'publish', 'production', 'prod', 'remove', 'erase'],
  security: ['auth', 'login', 'permission', 'role', 'token', 'secret', 'password', 'tenant', 'oauth', 'session', 'acl'],
  blast: ['schema', 'shared', 'contract', 'api', 'build', 'rename', 'refactor', 'every', 'all'],
  cost: ['llm', 'model', 'embedding', 'per item', 'fan-out', 'batch', 'backfill', 'reprocess'],
  userFacing: ['screen', 'page', 'modal', 'onboarding', 'copy', 'design', 'flow'],
}

function words(text) {
  return ` ${String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}/.+-]+/gu, ' ')} `
}

function hasWord(hay, w) {
  return hay.includes(` ${w.toLowerCase()} `)
}

function diffTokensOf(repo, base) {
  if (!repo || !base) return ''
  const mb = spawnSync('git', ['merge-base', base, 'HEAD'], { cwd: repo, encoding: 'utf8' })
  const from = mb.status === 0 ? mb.stdout.trim() : base
  const r = spawnSync('git', ['diff', '-U0', '--no-color', from], { cwd: repo, encoding: 'utf8', maxBuffer: 64 << 20 })
  return (r.stdout ?? '').split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).join('\n')
}

function touchedPaths(repo, base) {
  if (!repo || !base) return []
  const mb = spawnSync('git', ['merge-base', base, 'HEAD'], { cwd: repo, encoding: 'utf8' })
  const from = mb.status === 0 ? mb.stdout.trim() : base
  const r = spawnSync('git', ['diff', '--name-only', from], { cwd: repo, encoding: 'utf8' })
  return (r.stdout ?? '').split('\n').filter(Boolean)
}

function memoryDomains(repo, paths) {
  const out = []
  if (!repo || !paths.length) return out
  const dir = path.join(repo, '.jstack', 'memory', 'entries')
  let files = []
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')) } catch { return out }
  for (const f of files) {
    try {
      const e = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
      if (e.status === 'retired') continue
      const hit = (e.anchors ?? []).some(a => paths.includes(a.path))
      if (hit) for (const d of e.domains ?? []) out.push({ domain: d, id: e.id, kind: e.kind })
      // unslop-ignore: conc.empty-catch a malformed entry is skipped here; memory.mjs lint reports it
    } catch {}
  }
  return out
}

function classify({ task = '', paths = [], repo = null, base = null, packs = loadPacks() } = {}) {
  const project = loadProjectConfig(repo)
  const ignore = ignoreGlobs(project)
  const allPaths = [...new Set([...paths, ...touchedPaths(repo, base)])].filter(p => !matchAny(p, ignore))
  const hay = words(task)
  const diff = diffTokensOf(repo, base)
  const mem = memoryDomains(repo, allPaths)
  const enabled = project?.domains && project.domains !== 'auto' ? new Set(project.domains) : null
  const rows = []
  for (const p of packs) {
    if (enabled && !enabled.has(p.domain)) continue
    const t = p.triggers ?? {}
    const reasons = []
    let score = 0
    const tw = (t.taskWords ?? []).filter(w => hasWord(hay, w))
    if (tw.length) { score += tw.length; reasons.push(`task words: ${tw.join(', ')}`) }
    const ph = allPaths.filter(f => matchAny(f, t.paths ?? []))
    if (ph.length) { score += 2; reasons.push(`paths: ${ph.slice(0, 4).join(', ')}${ph.length > 4 ? ` (+${ph.length - 4})` : ''}`) }
    const dt = diff ? (t.diffTokens ?? []).filter(tok => diff.includes(tok)) : []
    if (dt.length) { score += 1; reasons.push(`diff tokens: ${dt.slice(0, 5).join(', ')}`) }
    const mh = mem.filter(m => m.domain === p.domain)
    if (mh.length) { score += 2; reasons.push(`memory: ${mh.map(m => `${m.kind} ${m.id}`).join(', ')}`) }
    if (score) rows.push({ domain: p.domain, skill: p.skill, score, reasons })
  }
  rows.sort((a, b) => b.score - a.score || a.domain.localeCompare(b.domain))
  const chosen = rows.filter(r => r.score >= 2)
  const weak = rows.filter(r => r.score < 2)
  if (chosen.length) {
    for (const c of COMPANIONS) {
      if (chosen.some(r => r.domain === c)) continue
      const pack = packs.find(p => p.domain === c)
      if (pack && (!enabled || enabled.has(c))) chosen.push({ domain: c, skill: pack.skill, score: 0, reasons: ['companion: every change needs its oracle (a check written before the code)'] })
    }
  }
  const risk = {}
  for (const [axis, list] of Object.entries(RISK_WORDS)) {
    const hit = list.filter(w => hasWord(hay, w))
    if (hit.length) risk[axis] = hit
  }
  let points = Object.keys(risk).length + (allPaths.length > 8 ? 2 : allPaths.length > 2 ? 1 : 0) + (chosen.length > 3 ? 1 : 0)
  if (risk.irreversibility) points++
  if (risk.security) points++
  let tier = points >= 6 ? 'L' : points >= 3 ? 'M' : 'S'
  if (tier === 'S' && (risk.irreversibility || risk.security)) tier = 'M'
  return { domains: chosen, weak, tierHint: { tier, points, risk }, paths: allPaths }
}

function main(argv) {
  const get = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null }
  const repo = get('--repo') ?? (get('--base') ? process.cwd() : null)
  const res = classify({ task: get('--task') ?? '', paths: (get('--paths') ?? '').split(',').filter(Boolean), repo, base: get('--base') })
  if (argv.includes('--json')) { process.stdout.write(JSON.stringify(res, null, 2) + '\n'); return 0 }
  const lines = res.domains.length ? res.domains.map(d => `${d.domain.padEnd(18)} load skill ${d.skill}   (${d.reasons.join('; ')})`) : ['no domain pack matched: tier S with the generic questions, or add a domain with a reason']
  for (const w of res.weak) lines.push(`weak: ${w.domain} (${w.reasons.join('; ')}) -> add it if the task really touches it`)
  lines.push(`tier hint: ${res.tierHint.tier} (${res.tierHint.points} point(s)${Object.keys(res.tierHint.risk).length ? '; ' + Object.entries(res.tierHint.risk).map(([k, v]) => `${k}: ${v.join(', ')}`).join('; ') : ''}); confirm with skills/preflight/RISK.md`)
  process.stdout.write(lines.join('\n') + '\n')
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)))

export { classify }
