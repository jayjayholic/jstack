import type { AgentRow } from '../types'

type Info = { id: string; name?: string; type: string; description: string; status: string }
type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

const FINISHED = new Set(['completed', 'failed', 'killed'])

function blank(id: string, now: number): AgentRow {
  return { id, name: id.slice(0, 8), type: 'agent', description: '', status: 'running', startedAt: now, tokens: 0 }
}

function upsert(agents: AgentRow[], id: string, now: number, change: (a: AgentRow) => AgentRow): AgentRow[] {
  const found = agents.some(a => a.id === id)
  const base = found ? agents : [...agents, blank(id, now)]
  return base.map(a => (a.id === id ? change(a) : a))
}

// Folds the engine's agent list in; an agent the engine dropped keeps its row, marked finished.
function mergeList(agents: AgentRow[], infos: readonly Info[], now: number): AgentRow[] {
  let next = agents
  for (const info of infos) {
    next = upsert(next, info.id, now, a => ({
      ...a,
      name: info.name ?? info.type,
      type: info.type,
      description: info.description,
      status: info.status,
      // A message can resume an ended agent under the same id: it is live again.
      endedAt: FINISHED.has(info.status) ? (a.endedAt ?? now) : undefined,
    }))
  }
  const listed = new Set(infos.map(i => i.id))
  return next.map(a => (!listed.has(a.id) && a.endedAt === undefined ? { ...a, status: 'completed', endedAt: now } : a))
}

function addUsage(agents: AgentRow[], id: string, usage: Usage, now: number): AgentRow[] {
  const spent = usage.input_tokens + usage.output_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  return upsert(agents, id, now, a => ({ ...a, tokens: a.tokens + spent }))
}

function isFinished(a: AgentRow): boolean {
  return a.endedAt !== undefined
}

// Only a loop mid-turn counts as running; `waiting` and `idle` agents are parked, not working.
function isActive(a: AgentRow): boolean {
  return !isFinished(a) && (a.status === 'running' || a.status === 'pending')
}

// Completed agents leave the panel at once; a failed or killed one stays a minute so its end is seen.
const FINISHED_SHOWN_MS = 60_000

function withoutStale(agents: AgentRow[], now: number): AgentRow[] {
  return agents.filter(
    a => a.endedAt === undefined || (a.status !== 'completed' && now - a.endedAt < FINISHED_SHOWN_MS),
  )
}

// The status line after a limit error: where the session went, and who to resume (the main conversation first).
function resumeLine(nowOn: string | null, mainHit: boolean, agentNames: readonly string[]): string {
  const who = [...(mainHit ? ['the main conversation'] : []), ...[...new Set(agentNames)].map(n => `@${n}`)]
  const where = nowOn ? `now on ${nowOn}` : 'no account to switch to'
  return who.length ? `Limit hit, ${where}. Resume: ${who.join(', ')}` : `Limit hit, ${where}.`
}

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h) return `${h}h ${m}m ${sec}s`
  if (m) return `${m}m ${sec}s`
  return `${sec}s`
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

export { resumeLine, addUsage, formatDuration, formatTokens, isActive, isFinished, mergeList, withoutStale }
