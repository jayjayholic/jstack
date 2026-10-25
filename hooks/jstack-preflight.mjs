// Pre-flight nudge: on the first Edit/Write of a session inside a git repo with no .agent/preflight.md, tell the agent
// once that it should class the task (quick / light / full) and what the signals suggest. Never blocks: it only adds
// context. Once a pre-flight names domains, the first edit after it gets those packs' questions and red flags, so they
// sit in the agent's context while it codes instead of only being listed. Opt out with JSTACK_PREFLIGHT=off or
// "preflight": { "enabled": false } in ~/.jstack/guards.json (top level or per project).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const JSTACK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

// Paths whose changes are never "quick", whatever the branch or the brief says.
const RISK_PATH = /(^|\/)migrations?\/|\.sql$|(^|\/)prisma\/|\.zmodel$|(^|\/)schema[./]|(^|\/)models?\.(ts|js|mjs|py)$|(^|[/_.-])(auth|oauth|sessions?|permissions?|roles?|acl|secrets?|crypto|payments?|billing|stripe|invoices?|checkout|pricing|quotas?|metering|llm|prompts?|openai|anthropic|embeddings?|ai-gateway|model-factory|erasure|deletion)([/_.-]|$)/i
const GROWTH_EVERY = 10
const ASK_HEAD = 700
const QUICK_BRANCH =/^(hotfix|chore|docs|style|copy|typo|config|ci)[/-]/i
const FULL_BRANCH = /^(feat|feature|refactor|perf)[/-]/i
const QUICK_WORDS = /\b(hotfix|quick|quickly|r[aá]pido|r[aá]pida|typo|copy change|rename only|bump|one-liner|small fix|tweak)\b/i
const RISK_WORDS = /\b(migrations?|schema change|backfill|auth|oauth|permissions?|payments?|billing|charges?|refunds?|idempoten\w*|race condition|double[- ]appl\w*|webhooks?|erasure|delete (?:all|every)|tenant)\b/i
const FULL_WORDS =/\b(feature|refactor|new flow|new screen|migration|schema|redesign|implement|build the|rewrite|architecture|nova feature|funcionalidade)\b/i

function git(cwd, args, timeout = 3000) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout, windowsHide: true })
  return r.status === 0 ? r.stdout.trim() : null
}

function repoOf(file) {
  let dir = path.dirname(file)
  while (!fs.existsSync(dir)) { const up = path.dirname(dir); if (up === dir) return null; dir = up }
  const top = git(dir, ['rev-parse', '--show-toplevel'])
  return top ? path.resolve(top) : null
}

function config(payload, env) {
  if (/^(off|0|false)$/i.test(env.JSTACK_PREFLIGHT ?? '')) return null
  let cfg = {}
  try { cfg = JSON.parse(fs.readFileSync(env.JSTACK_GUARDS_CONFIG || path.join(os.homedir(), '.jstack', 'guards.json'), 'utf8')) } catch {}
  if (cfg.preflight?.enabled === false) return null
  const here = [env.CLAUDE_PROJECT_DIR, payload.cwd].filter(Boolean).map(p => path.resolve(p).toLowerCase())
  const project = (cfg.projects ?? []).find(p => (p.roots ?? []).some(r => here.some(h => h.startsWith(path.resolve(r).toLowerCase()))))
  if (project?.preflight?.enabled === false) return null
  return { ...(cfg.preflight ?? {}), ...(project?.preflight ?? {}) }
}

function baseRef(repo, cfg, env) {
  for (const ref of [env.JSTACK_BASE, cfg.base, 'origin/HEAD', 'origin/main', 'origin/master'].filter(Boolean)) {
    if (git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) return ref
  }
  return null
}

function diffSoFar(repo, base) {
  const mb = base ? git(repo, ['merge-base', 'HEAD', base]) : null
  const out = git(repo, ['diff', '--numstat', mb ?? 'HEAD']) ?? ''
  let lines = 0
  const files = []
  for (const l of out.split('\n').filter(Boolean)) {
    const [a, d, f] = l.split('\t')
    lines += (Number(a) || 0) + (Number(d) || 0)
    files.push(f)
  }
  return { files, lines }
}

function firstAsk(payload) {
  const tp = payload.transcript_path
  if (!tp) return ''
  const candidates = payload.agent_id ? [path.join(tp.replace(/\.jsonl$/, ''), 'subagents', `agent-${payload.agent_id}.jsonl`), tp] : [tp]
  for (const f of candidates) {
    try {
      const fd = fs.openSync(f, 'r')
      const buf = Buffer.alloc(200_000)
      const n = fs.readSync(fd, buf, 0, buf.length, 0)
      fs.closeSync(fd)
      for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
        let o
        try { o = JSON.parse(line) } catch { continue }
        if (o.type !== 'user') continue
        const c = o.message?.content
        const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(x => x?.type === 'text').map(x => x.text).join(' ') : ''
        if (text.trim()) return text.slice(0, 4000)
      }
    } catch {}
  }
  return ''
}

function readBrief(repo) {
  try { return fs.readFileSync(path.join(repo, '.agent', 'brief.md'), 'utf8').slice(0, 4000) } catch { return '' }
}

// The class the signals suggest. The agent decides; this only names the evidence.
// Only the head of the ask is read for words: briefs put the task first and house rules (which mention permissions,
// erasure, migrations for every task) after it.
function suggestClass({ branch = '', files = [], lines = 0, target = '', ask: fullAsk = '' }) {
  const ask = fullAsk.slice(0, ASK_HEAD)
  const reasons = []
  const risky = [...new Set([target, ...files].filter(f => f && RISK_PATH.test(f.replace(/\\/g, '/'))))]
  if (risky.length) return { cls: 'full', reasons: [`risk paths: ${risky.slice(0, 3).join(', ')}`] }
  const riskWord = RISK_WORDS.exec(ask)?.[0]
  if (riskWord) return { cls: 'full', reasons: [`ask says "${riskWord}"`] }
  const big = files.length > 8 || lines > 300
  const quickWord = QUICK_WORDS.exec(ask)?.[0]
  if (QUICK_BRANCH.test(branch)) reasons.push(`branch ${branch}`)
  if (quickWord) reasons.push(`ask says "${quickWord}"`)
  // A diff only counts as small once there is one: at the first edit every branch has an empty diff.
  if (/^fix[/-]/i.test(branch) && files.length && files.length <= 3 && lines <= 40) reasons.push(`fix branch, diff ${files.length} file(s) / ${lines} line(s)`)
  if (reasons.length && !big) return { cls: 'quick', reasons }
  reasons.length = 0
  if (FULL_BRANCH.test(branch)) reasons.push(`branch ${branch}`)
  const fullWord = FULL_WORDS.exec(ask)?.[0]
  if (fullWord) reasons.push(`ask says "${fullWord}"`)
  if (files.length > 8 || lines > 300) reasons.push(`diff already ${files.length} file(s) / ${lines} line(s)`)
  if (reasons.length) return { cls: 'full', reasons }
  return { cls: 'light', reasons: ['no strong signal either way'] }
}

function readPreflight(repo, branch) {
  let text
  try { text = fs.readFileSync(path.join(repo, '.agent', 'preflight.md'), 'utf8') } catch { return null }
  const headLines = text.split('\n').slice(0, 6).join('\n')
  const forBranch = /^\s*branch:\s*(\S+)/mi.exec(text)?.[1]
  if (forBranch && branch && forBranch !== branch) return null
  const cls = /class:\s*(quick|light|full)/i.exec(headLines)?.[1]?.toLowerCase() ?? (/tier:\s*[SML]/.test(headLines) ? 'full' : 'light')
  const tier = /tier:\s*([SML])/.exec(headLines)?.[1] ?? (cls === 'full' ? 'M' : 'S')
  const sec = /^##\s*Domains[^\n]*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m.exec(text)?.[1] ?? ''
  const line = /^\s*domains?:\s*(.+)$/mi.exec(text)?.[1] ?? ''
  const prefixed = [...`${sec}\n${line}`.matchAll(/eng-([a-z0-9]+(?:-[a-z0-9]+)*)/g)].map(m => m[1])
  const cells = sec.split('\n').map(l => /^\|\s*([a-z0-9-]+)\s*\|/i.exec(l)?.[1]).filter(Boolean)
  const listed = line.split(/[,\s]+/).filter(Boolean)
  const domains = [...new Set((prefixed.length ? prefixed : [...cells, ...listed]).map(d => d.toLowerCase().replace(/^eng-/, '')))]
  return { cls, tier, domains }
}

function loadPacks() {
  const dir = path.join(JSTACK_ROOT, 'skills')
  const out = []
  for (const d of fs.readdirSync(dir)) {
    if (!d.startsWith('eng-')) continue
    try { out.push({ skill: `jstack:${d}`, ...JSON.parse(fs.readFileSync(path.join(dir, d, 'checks.json'), 'utf8')) }) } catch {}
  }
  return out
}

function packDigest(domains, tier, maxChars = 5000) {
  const packs = loadPacks().filter(p => domains.includes(p.domain))
  if (!packs.length) return ''
  const tiers = tier === 'S' ? ['S'] : ['S', 'M']
  const sev = tier === 'S' ? ['high'] : ['high', 'medium']
  const parts = []
  for (const p of packs) {
    const qs = (p.questions ?? []).filter(q => tiers.includes(q.tier)).map(q => `  - ${q.text}`)
    const flags = (p.rules ?? []).filter(r => sev.includes(r.severity ?? 'medium')).map(r => `  - ${r.title}`)
    parts.push([`${p.domain} (${p.skill}):`, 'questions:', ...qs, 'red flags /unslop will check:', ...flags].join('\n'))
  }
  let text = parts.join('\n')
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n  ... (cut; the full pack is in its skill)'
  return text
}

function classifyDomains(ask, paths) {
  try {
    const packs = loadPacks()
    const lower = ` ${ask.toLowerCase()} `
    const norm = paths.map(p => p.replace(/\\/g, '/'))
    const rows = []
    for (const p of packs) {
      const t = p.triggers ?? {}
      let score = (t.taskWords ?? []).filter(w => lower.includes(` ${w.toLowerCase()}`)).length
      if ((t.paths ?? []).some(g => norm.some(f => globMatch(f, g)))) score += 2
      if (score >= 2) rows.push([score, p.domain])
    }
    return rows.sort((a, b) => b[0] - a[0]).slice(0, 4).map(r => r[1])
  } catch { return [] }
}

function globMatch(file, glob) {
  const re = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '(?:.*/)?').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
  return new RegExp(`^${re}$`).test(file) || new RegExp(`(^|/)${re}$`).test(file)
}

function stateFile(payload, env) {
  const dir = path.join(env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), 'jstack-guards'), 'preflight')
  fs.mkdirSync(dir, { recursive: true })
  const key = `${payload.session_id ?? 'nosession'}__${payload.agent_id ?? 'main'}`.replace(/[^\w.-]/g, '-')
  return path.join(dir, `${key}.json`)
}

function nudgeText({ repo, branch, sug, tools }) {
  return [
    `jstack pre-flight: ${repo} (branch ${branch || 'detached'}) has no .agent/preflight.md yet. Signals suggest class "${sug.cls}" (${sug.reasons.join('; ')}). The class is the agent's call, written before more edits:`,
    '- quick (hotfix, quick fix, copy or style change, config): one line in .agent/preflight.md, `class: quick - <why>`. No ceremony, no /unslop.',
    '- light (ambiguous, the default): four lines, `class: light`, `ask: <the request quoted>`, `check: <command> -> pass when <threshold>`, `scope: <owned paths>`.',
    '- full (feature, refactor, new flow, schema or migration, auth or permissions, money, paid model calls): run the jstack:preflight skill; the chosen packs\' questions and red flags arrive on the next edit; /unslop on the diff before READY.',
    'Changes under migrations, auth, payments or LLM-call paths are full whatever the branch name says. This note appears once per session.',
    `jstack tools folder: ${tools}`,
  ].join('\n')
}

function edit(payload, env = process.env) {
  if (!EDIT_TOOLS.has(payload.tool_name)) return null
  const raw = payload.tool_input?.file_path ?? payload.tool_input?.notebook_path
  if (!raw) return null
  const cfg = config(payload, env)
  if (!cfg) return null
  const file = path.resolve(payload.cwd || process.cwd(), raw)
  const repo = repoOf(file)
  if (!repo) return null
  const rel = path.relative(repo, file).replace(/\\/g, '/')
  if (/^\.(agent|jstack)(\/|$)/.test(rel) || rel.startsWith('..')) return null

  const sf = stateFile(payload, env)
  let state = {}
  try { state = JSON.parse(fs.readFileSync(sf, 'utf8')) } catch {}
  const seen = state[repo] ?? {}
  const branch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']) ?? ''
  const pf = readPreflight(repo, branch)
  const tools = path.join(JSTACK_ROOT, 'tools')
  let text = null

  if (!pf) {
    const risky = RISK_PATH.test(rel)
    if (!seen.nudged || (risky && !seen.riskNudged)) {
      const { files, lines } = diffSoFar(repo, baseRef(repo, cfg, env))
      const ask = `${readBrief(repo)}\n${firstAsk(payload)}`
      const sug = suggestClass({ branch, files, lines, target: rel, ask })
      text = nudgeText({ repo, branch, sug, tools })
      seen.nudged = true
      if (sug.cls === 'full') seen.riskNudged = true
    } else {
      seen.edits = (seen.edits ?? 0) + 1
      if (!seen.grownNudged && seen.edits % GROWTH_EVERY === 0) {
        const { files, lines } = diffSoFar(repo, baseRef(repo, cfg, env))
        if (files.length > 8 || lines > 300) {
          text = `jstack pre-flight: still no .agent/preflight.md, and the diff is now ${files.length} file(s) / ${lines} line(s): past the size of a quick change. Write the class (light or full) before more edits. This note appears once.`
          seen.grownNudged = true
        }
      }
      state[repo] = seen
      try { fs.writeFileSync(sf, JSON.stringify(state)) } catch {}
    }
  } else if (pf.cls === 'quick') {
    seen.edits = (seen.edits ?? 0) + 1
    if (RISK_PATH.test(rel) && !seen.riskNudged) {
      text = `jstack pre-flight: .agent/preflight.md says class quick, and this edit touches ${rel}, a path that is full whatever the branch says (migrations, auth, payments, LLM calls). If the class no longer holds, run the jstack:preflight skill. This note appears once.`
      seen.riskNudged = true
    } else if (!seen.grownNudged && seen.edits % GROWTH_EVERY === 0) {
      const { files, lines } = diffSoFar(repo, baseRef(repo, cfg, env))
      if (files.length > 8 || lines > 300) {
        text = `jstack pre-flight: .agent/preflight.md says class quick, and the diff is now ${files.length} file(s) / ${lines} line(s). A change this size is usually light or full; if so, update the pre-flight before more edits. This note appears once.`
        seen.grownNudged = true
      }
    }
    state[repo] = seen
    try { fs.writeFileSync(sf, JSON.stringify(state)) } catch {}
  } else {
    let domains = pf.domains.filter(d => loadPacks().some(p => p.domain === d))
    if (!domains.length && pf.cls === 'light') domains = classifyDomains(`${readBrief(repo)}\n${firstAsk(payload)}`, [rel])
    const key = crypto.createHash('sha1').update(`${pf.tier}:${domains.sort().join(',')}`).digest('hex').slice(0, 12)
    if (domains.length && seen.packs !== key) {
      const digest = packDigest(domains, pf.tier)
      if (digest) text = `jstack packs for this pre-flight (class ${pf.cls}, tier ${pf.tier}), kept in view while coding:\n${digest}`
      seen.packs = key
    }
  }
  if (!text) return null
  state[repo] = seen
  try { fs.writeFileSync(sf, JSON.stringify(state)) } catch {}
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } }
}

export { edit, suggestClass, readPreflight, packDigest, classifyDomains, RISK_PATH }
