import type { SessionContextBreakdown } from 'claude-code'
import type { ContextItem, ContextView } from '../types'

const TOP = 10

// A category whose items the breakdown lists one by one is shown as those items, so the top list names the
// file, server, agent or skill that costs the most instead of its group.
const ITEM_GROUPS: { match: RegExp; items: (b: SessionContextBreakdown) => { label: string; tokens: number }[] }[] = [
  { match: /memory/i, items: b => b.memoryFiles.map(f => ({ label: shortPath(f.path), tokens: f.tokens })) },
  { match: /mcp/i, items: b => byServer(b) },
  { match: /agent/i, items: b => b.agents.map(a => ({ label: `agent ${a.agentType}`, tokens: a.tokens })) },
  { match: /skill/i, items: b => (b.skills?.skillFrontmatter ?? []).map(s => ({ label: `skill ${s.name}`, tokens: s.tokens })) },
]

function shortPath(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.slice(-2).join('/')
}

function byServer(b: SessionContextBreakdown): { label: string; tokens: number }[] {
  const totals = new Map<string, number>()
  for (const tool of b.mcpTools) if (tool.isLoaded) totals.set(tool.serverName, (totals.get(tool.serverName) ?? 0) + tool.tokens)
  return [...totals].map(([server, tokens]) => ({ label: `mcp ${server}`, tokens }))
}

// The window as /context breaks it down: what is used, by category for the stacked bar, and the ten biggest
// consumers with their share of what is used.
function contextView(b: SessionContextBreakdown): ContextView {
  const used = b.categories.filter(c => c.kind === 'used' && c.tokens > 0)
  const free = b.categories.filter(c => c.kind === 'free' || c.kind === 'buffer').reduce((sum, c) => sum + c.tokens, 0)
  const usedTokens = used.reduce((sum, c) => sum + c.tokens, 0)
  const items: ContextItem[] = []
  for (const category of used) {
    const group = ITEM_GROUPS.find(g => g.match.test(category.name))
    const parts = group ? group.items(b).filter(p => p.tokens > 0) : []
    if (parts.length === 0) {
      items.push({ label: category.name, tokens: category.tokens, color: category.color })
      continue
    }
    const listed = parts.reduce((sum, p) => sum + p.tokens, 0)
    for (const p of parts) items.push({ ...p, color: category.color })
    if (category.tokens - listed > 0) items.push({ label: `${category.name} (rest)`, tokens: category.tokens - listed, color: category.color })
  }
  const top = items.sort((a, z) => z.tokens - a.tokens).slice(0, TOP)
  return {
    percent: b.percentage,
    usedTokens,
    maxTokens: b.rawMaxTokens,
    freeTokens: free,
    segments: used.map(c => ({ label: c.name, tokens: c.tokens, color: c.color })),
    top: top.map(i => ({ ...i, share: usedTokens > 0 ? i.tokens / usedTokens : 0 })),
    more: Math.max(0, items.length - TOP),
  }
}

// Cells per segment for a bar of `width` cells, by largest remainder; every non-empty segment gets at least one
// cell while there is room.
function cellsOf(tokens: readonly number[], total: number, width: number): number[] {
  if (total <= 0 || width <= 0) return tokens.map(() => 0)
  const exact = tokens.map(t => (t / total) * width)
  const cells = exact.map(x => Math.floor(x))
  for (let i = 0; i < cells.length; i++) if (tokens[i]! > 0 && cells[i] === 0) cells[i] = 1
  let left = width - cells.reduce((s, c) => s + c, 0)
  const order = exact.map((x, i) => ({ i, r: x - Math.floor(x) })).sort((a, z) => z.r - a.r)
  for (let k = 0; left > 0 && order.length; k = (k + 1) % order.length, left--) cells[order[k]!.i]!++
  while (left < 0) {
    const biggest = cells.indexOf(Math.max(...cells))
    if (cells[biggest]! <= 1) break
    cells[biggest]!--
    left++
  }
  return cells
}

export { cellsOf, contextView }
