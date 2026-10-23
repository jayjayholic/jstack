import { expect, test } from 'claude-code/testing'
import type { SessionContextBreakdown } from 'claude-code'
import { cellsOf, contextView } from './context'

function breakdown(over: Partial<SessionContextBreakdown> = {}): SessionContextBreakdown {
  return {
    categories: [
      { name: 'System prompt', tokens: 4_000, color: 'promptBorder', isDeferred: false, kind: 'used' },
      { name: 'Memory files', tokens: 9_000, color: 'claude', isDeferred: false, kind: 'used' },
      { name: 'MCP tools', tokens: 3_000, color: 'cyan', isDeferred: false, kind: 'used' },
      { name: 'Messages', tokens: 60_000, color: 'purple', isDeferred: false, kind: 'used' },
      { name: 'Free space', tokens: 100_000, color: 'inactive', isDeferred: false, kind: 'free' },
      { name: 'Autocompact buffer', tokens: 24_000, color: 'inactive', isDeferred: false, kind: 'buffer' },
      { name: 'MCP tools (deferred)', tokens: 50_000, color: 'cyan', isDeferred: true, kind: 'deferred' },
    ],
    totalTokens: 76_000,
    maxTokens: 200_000,
    rawMaxTokens: 200_000,
    autocompactSource: 'model' as never,
    percentage: 38,
    gridRows: [],
    model: 'opus',
    memoryFiles: [
      { path: 'C:\\repo\\CLAUDE.md', type: 'Project', tokens: 7_000 },
      { path: 'C:\\Users\\me\\.claude\\CLAUDE.md', type: 'User', tokens: 1_500 },
    ],
    mcpTools: [
      { name: 'mcp__git__log', serverName: 'git', tokens: 1_000, isLoaded: true },
      { name: 'mcp__git__diff', serverName: 'git', tokens: 1_000, isLoaded: true },
      { name: 'mcp__jira__get', serverName: 'jira', tokens: 900, isLoaded: false },
    ],
    agents: [],
    isAutoCompactEnabled: true,
    apiUsage: null,
    ...over,
  }
}

test('splits a category into the items the breakdown lists, keeping what they leave out as its rest', () => {
  const view = contextView(breakdown())
  expect(view.top[0]).toMatchObject({ label: 'Messages', tokens: 60_000, color: 'purple' })
  expect(view.top.find(i => i.label === 'repo/CLAUDE.md')).toMatchObject({ tokens: 7_000, color: 'claude' })
  expect(view.top.find(i => i.label === 'Memory files (rest)')?.tokens).toBe(500)
  expect(view.top.find(i => i.label === 'mcp git')?.tokens).toBe(2_000)
  expect(view.top.some(i => i.label === 'mcp jira')).toBe(false)
  expect(view.usedTokens).toBe(76_000)
  expect(view.freeTokens).toBe(124_000)
  expect(Math.abs(view.top.reduce((s, i) => s + i.share, 0) - 1) < 1e-9).toBe(true)
})

test('never counts deferred tool schemas, and keeps a category whole when it lists no items', () => {
  const view = contextView(breakdown({ memoryFiles: [], mcpTools: [] }))
  expect(view.segments.map(s => s.label)).toEqual(['System prompt', 'Memory files', 'MCP tools', 'Messages'])
  expect(view.top.find(i => i.label === 'Memory files')?.tokens).toBe(9_000)
  expect(view.top.some(i => i.label.includes('deferred'))).toBe(false)
})

test('keeps the ten biggest and counts the rest', () => {
  const memoryFiles = Array.from({ length: 14 }, (_, i) => ({ path: `/m/f${i}.md`, type: 'Project', tokens: 100 + i }))
  const total = memoryFiles.reduce((s, f) => s + f.tokens, 0)
  const view = contextView(
    breakdown({
      categories: [{ name: 'Memory files', tokens: total, color: 'claude', isDeferred: false, kind: 'used' }],
      memoryFiles,
    }),
  )
  expect(view.top).toHaveLength(10)
  expect(view.more).toBe(4)
  expect(view.top[0]!.label).toBe('m/f13.md')
})

test('a bar fills its width exactly, and a tiny non-empty segment still shows', () => {
  const cells = cellsOf([1, 500, 499], 1000, 20)
  expect(cells.reduce((s, c) => s + c, 0)).toBe(20)
  expect(cells[0]).toBe(1)
  expect(cellsOf([0, 0], 0, 20)).toEqual([0, 0])
})
