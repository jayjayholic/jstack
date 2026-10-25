#!/usr/bin/env node
// /unslop:retro, as a script: mine recent fix commits and agent transcripts for the slop that escaped, cluster it by
// domain, measure the escapes, and propose a pre-flight question and an eyes rule for each cluster that keeps
// coming back and that project memory doesn't already cover. No model calls; the proposals are drafts for a human.
//   node mine.mjs [--since 14.days] [--repo .] [--transcripts <file.jsonl|dir>]... [--min 3] [--json] [--out <file>]
// Transcripts: Claude Code session JSONL (or .txt/.md). Only the human's own messages that read like a bug report
// are used, as 200-character redacted gists. A directory is read one level deep, never walked.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { classify } from './classify.mjs'
import { loadPacks } from './rules.mjs'
import { redact } from '../memory/secrets.mjs'
import { loadEntries } from '../memory/memory.mjs'

const FIX = /^(?:fix|perf|revert|hotfix)(?:\([^)]*\))?!?:|^Revert "/i
const FEAT = /^feat(?:\([^)]*\))?!?:/i
const COMPLAINT = /\b(?:broken|breaks|bug|wrong|still|again|doesn'?t|does not|not working|didn'?t|failed|fails|failing|regress\w*|slow|stuck|missing|lost|crash\w*|error|why (?:is|does|did)|should(?:n'?t| not| have))\b/i
const STOP = new Set(['fix', 'fixes', 'fixed', 'perf', 'revert', 'when', 'with', 'from', 'that', 'this', 'into', 'after', 'before', 'still', 'again', 'should', 'does', 'doesnt', 'dont', 'not', 'the', 'and', 'for', 'are', 'was', 'its', 'one', 'now', 'only', 'never', 'every', 'more', 'less', 'make', 'made', 'stop', 'stops', 'keep', 'keeps', 'instead', 'first', 'second', 'also', 'them', 'they', 'what', 'which', 'sure', 'just', 'like', 'some', 'than', 'then', 'there', 'their', 'have', 'been', 'were', 'will', 'your'])
const GIST = 200

function git(repo, args) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 256 << 20 })
  return r.status === 0 ? (r.stdout ?? '').replace(/\r/g, '') : null
}

function validSince(s) {
  return typeof s === 'string' && /^[\w.:+ -]{1,40}$/.test(s) && !s.startsWith('-')
}

// Commits since a date, oldest first: { sha, at, subject, files, kind: fix|feat|other }.
function commitsSince(repo, since) {
  if (!validSince(since)) throw new Error(`--since: a git date like 14.days or 2026-10-01, got ${since}`)
  const out = git(repo, ['log', `--since=${since}`, '--no-merges', '--format=%x1e%h%x1f%cI%x1f%s', '--name-only']) ?? ''
  return out.split('\x1e').filter(Boolean).map(block => {
    const [head, ...rest] = block.split('\n')
    const [sha, at, subject] = head.split('\x1f')
    const kind = FIX.test(subject) ? 'fix' : FEAT.test(subject) ? 'feat' : 'other'
    return { sha, at, subject: redact(subject).text, files: rest.map(s => s.trim()).filter(Boolean), kind }
  }).reverse()
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter(c => c?.type === 'text' && typeof c.text === 'string').map(c => c.text).join('\n')
  return ''
}

// The human's bug-report-like messages from one transcript, as redacted gists.
function gistsFromTranscript(file) {
  let raw = ''
  try { raw = fs.readFileSync(file, 'utf8') } catch { return [] }
  const msgs = []
  if (/\.jsonl$/i.test(file)) {
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      let j
      try { j = JSON.parse(line) } catch { continue }
      if (j?.type !== 'user' || j.isMeta || j.isSidechain) continue
      const t = textOf(j.message?.content).trim()
      if (t && !t.startsWith('<')) msgs.push({ text: t, at: j.timestamp ?? null })
    }
  } else {
    for (const para of raw.split(/\n\s*\n/)) if (para.trim()) msgs.push({ text: para.trim(), at: null })
  }
  return msgs.filter(m => COMPLAINT.test(m.text)).map(m => ({ gist: redact(m.text.replace(/\s+/g, ' ')).text.slice(0, GIST), at: m.at, source: path.basename(file) }))
}

function transcriptFiles(inputs) {
  const out = []
  for (const p of inputs) {
    let st
    try { st = fs.statSync(p) } catch { continue }
    if (st.isFile()) out.push(p)
    else if (st.isDirectory()) for (const f of fs.readdirSync(p)) if (/\.(jsonl|txt|md)$/i.test(f)) out.push(path.join(p, f))
  }
  return out
}

const words = s => String(s).toLowerCase().replace(/^[a-z]+(\([^)]*\))?!?:\s*/, '').match(/[a-z][a-z-]{3,}/g)?.filter(w => !STOP.has(w)) ?? []

function topN(counts, n) {
  return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([k]) => k)
}

function domainOf(text, files, packs) {
  const r = classify({ task: text, paths: files, packs })
  return r.domains[0]?.domain ?? r.weak[0]?.domain ?? 'unclassified'
}

const median = xs => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }

function mine({ repo, since = '14.days', transcripts = [], min = 3, packs = loadPacks() } = {}) {
  const commits = commitsSince(repo, since)
  const fixes = commits.filter(c => c.kind === 'fix')
  const feats = commits.filter(c => c.kind === 'feat')
  // Escape latency: days from the last non-fix commit that touched a file to the fix that touched it again.
  const lastTouch = new Map()
  const latency = []
  for (const c of commits) {
    if (c.kind === 'fix') {
      const prior = c.files.map(f => lastTouch.get(f)).filter(Boolean).sort().at(-1)
      if (prior) latency.push((Date.parse(c.at) - Date.parse(prior)) / 86400000)
    } else for (const f of c.files) lastTouch.set(f, c.at)
  }
  const escapes = [
    ...fixes.map(c => ({ kind: 'commit', ref: c.sha, at: c.at, text: c.subject, files: c.files })),
    ...transcriptFiles(transcripts).flatMap(gistsFromTranscript).map(g => ({ kind: 'transcript', ref: g.source, at: g.at, text: g.gist, files: [] })),
  ]
  const clusters = new Map()
  for (const e of escapes) {
    const d = domainOf(e.text, e.files, packs)
    const c = clusters.get(d) ?? { domain: d, escapes: 0, commits: 0, reports: 0, items: [], fileCounts: {}, wordCounts: {} }
    c.escapes++
    c[e.kind === 'commit' ? 'commits' : 'reports']++
    c.items.push({ kind: e.kind, ref: e.ref, at: e.at, text: e.text.slice(0, GIST) })
    for (const f of e.files) c.fileCounts[f] = (c.fileCounts[f] ?? 0) + 1
    for (const w of new Set(words(e.text))) c.wordCounts[w] = (c.wordCounts[w] ?? 0) + 1
    clusters.set(d, c)
  }
  const memory = repo ? loadEntries(repo).filter(e => ['failure', 'known-slop'].includes(e.kind) && e.status !== 'retired') : []
  const out = [...clusters.values()].map(c => {
    const topPaths = topN(c.fileCounts, 3)
    const topWords = topN(c.wordCounts, 3)
    const covered = memory.filter(e => (e.anchors ?? []).some(a => topPaths.includes(a.path)) || (e.domains ?? []).includes(c.domain) && topWords.some(w => String(e.title).toLowerCase().includes(w))).map(e => e.id)
    const recurring = c.escapes >= min
    const proposal = recurring && !covered.length && c.domain !== 'unclassified' ? {
      question: { id: `${c.domain.split('-')[0]}.q.retro-${topWords[0] ?? 'escape'}`, tier: 'S', text: `${topPaths.length ? `Before changing ${topPaths.join(', ')}: ` : ''}${c.escapes} fixes since ${since} were about "${topWords.join(' ')}". What breaks it, and which check proves it can't break again?`, produces: 'text' },
      rule: { id: `${c.domain.split('-')[0]}.retro-${topWords[0] ?? 'escape'}`, domain: c.domain, engine: 'eyes', title: `Recurring escape: ${topWords.join(' ')}`, ...(topPaths.length ? { files: [...new Set(topPaths.map(p => (path.posix.dirname(p) === '.' ? '' : path.posix.dirname(p) + '/') + '**'))] } : {}), severity: 'medium', mode: 'eyes-hint', why: `${c.escapes} escapes in ${since}: ${c.items.slice(0, 3).map(i => i.ref).join(', ')}`, confirm: 'failing-test reproducing the most recent escape' },
    } : null
    return { domain: c.domain, escapes: c.escapes, commits: c.commits, reports: c.reports, topPaths, topWords, covered, recurring, proposal, items: c.items.slice(-8) }
  }).sort((a, b) => b.escapes - a.escapes)
  return {
    since,
    metrics: {
      commits: commits.length, fixes: fixes.length, feats: feats.length,
      lateFixRatio: feats.length ? fixes.length / feats.length : null,
      escapesPerDomain: Object.fromEntries(out.map(c => [c.domain, c.escapes])),
      medianEscapeDays: median(latency),
      topFixedFiles: topN(fixes.flatMap(c => c.files).reduce((a, f) => (a[f] = (a[f] ?? 0) + 1, a), {}), 5),
      transcriptReports: escapes.filter(e => e.kind === 'transcript').length,
    },
    clusters: out,
  }
}

function main(argv) {
  const get = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }
  const transcripts = argv.flatMap((a, i) => a === '--transcripts' ? [argv[i + 1]] : []).filter(Boolean)
  const repo = path.resolve(get('--repo') ?? '.')
  let res
  try { res = mine({ repo, since: get('--since') ?? '14.days', transcripts, min: Number(get('--min') ?? 3) }) } catch (e) { console.error(e.message); return 2 }
  const d = new Date()
  const localDay = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const out = get('--out') ?? path.join(repo, '.jstack', 'local', 'retro', `${localDay}.json`)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify(res, null, 2) + '\n')
  // unslop-ignore: perf.log-whole-payload --json prints the result on purpose; it is redacted gists and counts
  if (argv.includes('--json')) { console.log(JSON.stringify(res, null, 2)); return 0 }
  const m = res.metrics
  console.log(`since ${res.since}: ${m.fixes} fix / ${m.feats} feat commit(s), late-fix ratio ${m.lateFixRatio == null ? 'n/a' : m.lateFixRatio.toFixed(2)}, median ${m.medianEscapeDays == null ? 'n/a' : m.medianEscapeDays.toFixed(1)} day(s) from change to fix, ${m.transcriptReports} report(s) from transcripts`)
  for (const c of res.clusters) {
    console.log(`${c.domain.padEnd(18)} ${String(c.escapes).padStart(3)} escape(s)  ${c.topWords.join(' ')}${c.topPaths.length ? `  [${c.topPaths.join(', ')}]` : ''}${c.covered.length ? `  covered by memory ${c.covered.join(', ')}` : ''}`)
    if (c.proposal) console.log(`  propose question: ${c.proposal.question.text}\n  propose rule:     ${c.proposal.rule.id} (eyes-hint)`)
  }
  console.log(`written: ${out}`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)))

export { mine, commitsSince, gistsFromTranscript, validSince }
