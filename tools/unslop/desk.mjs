#!/usr/bin/env node
// The /unslop front desk: before anything costs agents, look at the repo and suggest a scope. Prints the options
// with what each would scan (commits, files, added lines, static hits, domains, estimated agents) and the
// recommended one. The skill shows this as a menu; nothing is scanned by agents until the human picks.
//   node desk.mjs [--base origin/main] [--recent 5] [--repo .] [--json]
// Scopes: branch (merge-base..HEAD plus uncommitted work, the default), pr (the open PR's base, via gh when present),
// recent (the last N commits), full (every tracked file; the expensive one, never the default).
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { scan } from './scan.mjs'
import { classify } from './classify.mjs'

const MAX_AGENTS = Number(process.env.JSTACK_UNSLOP_MAX_AGENTS ?? 4)
const MAX_CANDIDATES = Number(process.env.JSTACK_UNSLOP_MAX_CANDIDATES ?? 25)

function git(repo, args) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 << 20 })
  return r.status === 0 ? (r.stdout ?? '').replace(/\r/g, '').trim() : null
}

function diffSize(repo, from) {
  const stat = git(repo, ['diff', '--numstat', '--end-of-options', from]) ?? ''
  let files = 0, added = 0
  for (const l of stat.split('\n').filter(Boolean)) { files++; added += Number(l.split('\t')[0]) || 0 }
  const untracked = (git(repo, ['ls-files', '--others', '--exclude-standard']) ?? '').split('\n').filter(Boolean).length
  return { files: files + untracked, added, untracked }
}

function openPr(repo, gh) {
  const r = gh(['pr', 'view', '--json', 'number,baseRefName,title'], repo)
  if (!r) return null
  try { const j = JSON.parse(r); return j.baseRefName ? { number: j.number, base: `origin/${j.baseRefName}`, title: j.title } : null } catch { return null }
}

function defaultGh(args, cwd) {
  const r = spawnSync('gh', args, { cwd, encoding: 'utf8', timeout: 10_000 })
  return r.status === 0 ? r.stdout : null
}

// What each scope would cost: one static scan (cheap, run now) and the agents the full pipeline would spend.
function estimate(repo, { base, full }) {
  const res = full ? scan({ repo, full: '.' }) : scan({ repo, base })
  const domains = full ? [...new Set(res.candidates.map(c => c.domain))] : classify({ repo, base }).domains.map(d => d.domain)
  const toConfirm = Math.min(res.candidates.length, MAX_CANDIDATES)
  return { staticHits: res.candidates.length, files: res.files, domains, agents: domains.length + toConfirm * 2, ms: res.ms }
}

function facts(repo, { base = 'origin/main', recent = 5, gh = defaultGh } = {}) {
  const mb = git(repo, ['merge-base', '--end-of-options', base, 'HEAD'])
  const ahead = mb ? Number(git(repo, ['rev-list', '--count', `${mb}..HEAD`]) ?? 0) : null
  const dirty = (git(repo, ['status', '--porcelain']) ?? '').split('\n').filter(Boolean).length
  const total = Number(git(repo, ['rev-list', '--count', 'HEAD']) ?? 0)
  const n = Math.max(1, Math.min(recent, total - 1))
  const recentBase = total > 1 ? git(repo, ['rev-parse', `HEAD~${n}`]) : null
  return {
    base, mergeBase: mb, ahead, dirty, commits: total,
    branch: git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']),
    branchSize: mb ? diffSize(repo, mb) : null,
    recent: recentBase ? { n, base: recentBase, ...diffSize(repo, recentBase) } : null,
    pr: openPr(repo, gh),
    tracked: (git(repo, ['ls-files']) ?? '').split('\n').filter(Boolean).length,
  }
}

// Pure: which scope fits. The branch when it has work, the PR when one is open, recent commits on a clean base
// branch, full only when there is nothing smaller to look at.
function recommend(f) {
  const options = []
  if (f.pr) options.push({ id: 'pr', label: `This PR #${f.pr.number} (vs ${f.pr.base})`, args: ['--base', f.pr.base] })
  if (f.mergeBase && ((f.ahead ?? 0) > 0 || f.dirty > 0)) options.push({ id: 'branch', label: `This branch: ${f.ahead} commit(s) ahead of ${f.base}${f.dirty ? `, ${f.dirty} uncommitted file(s)` : ''}`, args: ['--base', f.base] })
  if (f.recent) options.push({ id: 'recent', label: `The last ${f.recent.n} commit(s)`, args: ['--base', f.recent.base] })
  options.push({ id: 'full', label: `Full project: ${f.tracked} tracked file(s), the expensive one`, args: ['--full', '.'] })
  const pick = options.find(o => o.id === 'pr') ?? options.find(o => o.id === 'branch') ?? options.find(o => o.id === 'recent') ?? options.at(-1)
  const why = pick.id === 'pr' ? 'an open PR: review exactly what it would merge'
    : pick.id === 'branch' ? 'this branch has its own work; scanning only what it added is fast and precise'
      : pick.id === 'recent' ? `no branch work vs ${f.base}; the latest commits are the fresh risk`
        : 'nothing smaller to scan'
  return { recommended: pick.id, why, options: options.map(o => ({ ...o, recommended: o.id === pick.id })) }
}

function suggest(repo, opts = {}) {
  const f = facts(repo, opts)
  const r = recommend(f)
  for (const o of r.options) {
    const base = o.args[0] === '--base' ? o.args[1] : null
    o.estimate = o.id === 'full' && !opts.estimateFull ? { files: f.tracked, note: 'not pre-scanned: run with --estimate-full to count its static hits' } : estimate(repo, { base, full: o.id === 'full' })
  }
  return { facts: f, ...r }
}

function main(argv) {
  const get = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }
  const repo = path.resolve(get('--repo') ?? '.')
  const s = suggest(repo, { base: get('--base') ?? 'origin/main', recent: Number(get('--recent') ?? 5), estimateFull: argv.includes('--estimate-full') })
  if (argv.includes('--json')) { console.log(JSON.stringify(s, null, 2)); return 0 }
  for (const o of s.options) {
    const e = o.estimate
    console.log(`${o.recommended ? '*' : ' '} ${o.id.padEnd(7)} ${o.label}`)
    console.log(`          ${e.staticHits != null ? `${e.files} file(s), ${e.staticHits} static hit(s), domains ${e.domains.join(', ') || 'none'}, up to ~${e.agents} agent run(s) (max ${MAX_AGENTS} at once)` : `${e.files} file(s); ${e.note}`}`)
    console.log(`          node scan.mjs ${o.args.join(' ')}`)
  }
  console.log(`recommended: ${s.recommended} (${s.why})`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)))

export { recommend, facts, suggest }
