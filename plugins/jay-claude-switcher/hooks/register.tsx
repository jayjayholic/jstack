import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'
import type { AgentRow, ContextView, Doing, Row, Task } from '../types'
import { addUsage, formatDuration, formatTokens, isActive, isFinished, mergeList, withoutStale } from './agents'
import { cellsOf, contextView } from './context'
import { addSample, forecast, rowOf, type Sample } from './forecast'
import { renderSessions } from './sessions-pane'
import { autoSwitchTick, backgroundRefresh, loadAutoSwitch, noteSessionLimits, refreshSessions, sessionsReport } from './sessions'
import { created, detailOf, fromListText, fromTodos, updated } from './tasks'

const PANE = 'switcher-work'
const SESSIONS_PANE = 'switcher-sessions'
const TITLE = 'Work'
const COLUMNS = 46
const tasks = atom({ plugin: 'jay-claude-switcher', key: 'tasks' } as const, [] as Task[])
const doing = atom({ plugin: 'jay-claude-switcher', key: 'doing' } as const, [] as Doing[])
const showDone = atom({ plugin: 'jay-claude-switcher', key: 'showDone' } as const, false)
const agents = atom({ plugin: 'jay-claude-switcher', key: 'agents' } as const, [] as AgentRow[])
const now = atom({ plugin: 'jay-claude-switcher', key: 'now' } as const, 0)
const usage = atom({ plugin: 'jay-claude-switcher', key: 'usage' } as const, [] as Row[])
const context = atom({ plugin: 'jay-claude-switcher', key: 'context' } as const, null as ContextView | null)

const SAMPLES = 'usage-samples'
const MINUTE = 60_000
const BAR = 10
const LABEL_WIDTH = 6

// Records each limit window's reading across sessions, then recomputes the rows shown at the top of the panel.
async function refreshUsage($: EngineInterface, limits: readonly SessionRateLimit[]): Promise<void> {
  const t = await $.clock.now()
  // A store that cannot be read or written (a corrupt file, a stale lock) costs the history, never the rows.
  let samples = (((await $.store.get(SAMPLES).catch(() => undefined)) as Sample[] | undefined) ?? [])
  for (const l of limits) samples = addSample(samples, { t, kind: l.kind, p: l.percentUsed, resetsAt: l.resetsAt })
  if (limits.length) await $.store.set(SAMPLES, samples).catch(() => undefined)
  const rows = limits.map(l => rowOf(forecast(samples, { t, kind: l.kind, p: l.percentUsed, resetsAt: l.resetsAt }, t), t, samples))
  await update($, usage, () => rows)
}

// The window by category, estimated locally (`summary` sends no request), as /context breaks it down.
async function refreshContext($: EngineInterface): Promise<void> {
  const { context: c } = await $.session.usage({ breakdown: 'summary' })
  if (c.breakdown) await update($, context, () => contextView(c.breakdown!))
}

const TASK_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'])

// The list made before this plugin loaded is only known to the engine: ask it once.
async function seedTasks($: EngineInterface): Promise<void> {
  const { text } = await $.tool.call({ tool: 'TaskList' })
  await update($, tasks, list => fromListText(list, text))
}

async function syncAgents($: EngineInterface): Promise<void> {
  const [infos, t] = await Promise.all([$.agent.list(), $.clock.now()])
  await update($, agents, list => withoutStale(mergeList(list, infos, t), t))
  await update($, now, () => t)
}

// Sessions first, so the Work tab is the one shown.
async function openPanes($: EngineInterface, focus: boolean): Promise<void> {
  await $.ui.open({ id: SESSIONS_PANE, title: 'Sessions', columns: COLUMNS })
  await $.ui.open({ id: PANE, title: TITLE, columns: COLUMNS, ...(focus ? { focus: true as const } : {}) })
}

function bar(fraction: number): [string, string] {
  const cells = Math.max(0, Math.min(BAR, Math.round(fraction * BAR)))
  return ['█'.repeat(cells), '░'.repeat(BAR - cells)]
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({ name: 'switcher', description: 'Open the work panel: limits, tasks, agents, what is running' })
    await $.command.register({ name: 'switcher-accounts', description: 'Read every stored Claude account now and list its 5h and weekly usage' })
    void openPanes($, false).catch(() => undefined)
    void seedTasks($).catch(() => undefined)
    $.clock.every(1000, () => syncAgents($).catch(() => undefined))
    void $.session.usage().then(u => refreshUsage($, u.rateLimits)).catch(() => undefined)
    void refreshContext($).catch(() => undefined)
    // Accounts: listed from the store with no network; the usage endpoint is asked only from 98% on the current
    // account (once a minute) and, when a switch is due, once for the others. The switch check runs every second.
    void loadAutoSwitch($)
      .then(() => refreshSessions($, 'none'))
      .then(() => $.session.usage())
      .then(u => noteSessionLimits($, u.rateLimits))
      .catch(() => undefined)
    $.clock.every(5_000, () => void backgroundRefresh($).catch(() => undefined))
    $.clock.every(1000, () => void autoSwitchTick($).catch(() => undefined))
    // A reading every 10 s, idle or not: the forecast reads the last minute, and flat readings make a 0%/h rate.
    $.clock.every(10_000, () => {
      void $.session.usage().then(u => refreshUsage($, u.rateLimits)).catch(() => undefined)
    })
    return result
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      await refreshUsage($, e.rateLimits).catch(() => undefined)
      await noteSessionLimits($, e.rateLimits).catch(() => undefined)
    }
    if (e.changed.includes('context')) await refreshContext($).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'switcher-accounts' }, async $ => {
    return { text: await sessionsReport($) }
  }).catch(() => ({ text: 'switcher-accounts: could not read the accounts.' }))

  on('command.run', { command: 'switcher' }, async $ => {
    await openPanes($, true)
    await seedTasks($).catch(() => undefined)
    return { text: 'Work panel opened.' }
  }).catch(() => ({ text: 'switcher: could not open the panel.' }))

  // Bookkeeping must never fail the tool call itself: every state write swallows its own error.
  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    const agentId = e.agentId
    const isTaskTool = TASK_TOOLS.has(e.tool)
    if (!isTaskTool && !agentId) {
      await (async () => {
        const t = await $.clock.now()
        const detail = detailOf(e.tool, input)
        await update($, doing, list => [...list, { id: e.tool_use_id, tool: e.tool, detail, startedAt: t }].slice(-8))
      })().catch(() => undefined)
    }
    const ran = await next(e)
    await (async () => {
      if (!isTaskTool && !agentId) await update($, doing, list => list.filter(d => d.id !== e.tool_use_id))
      if (ran.deny !== undefined || ran.isError || agentId) return
      if (e.tool === 'TodoWrite') {
        await update($, tasks, () => fromTodos((input['todos'] as never) ?? []))
      } else if (e.tool === 'TaskCreate') {
        await update($, tasks, list => created(list, ran.text, String(input['subject'] ?? ''), input['activeForm'] as string | undefined))
      } else if (e.tool === 'TaskUpdate') {
        await update($, tasks, list => updated(list, input as never))
      } else if (e.tool === 'TaskList') {
        await update($, tasks, list => fromListText(list, ran.text))
      }
    })().catch(() => undefined)
    return ran
  })

  // Each subagent step: its tokens into its row.
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    const agentId = e.agentId
    if (agentId && r?.usage) {
      await (async () => {
        const t = await $.clock.now()
        await update($, agents, list => addUsage(list, agentId, r.usage!, t))
      })().catch(() => undefined)
    }
    return r
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const [all, running, isShowingDone, rows, t, limits, ctx] = await Promise.all([
      read($, tasks),
      read($, doing),
      read($, showDone),
      read($, agents),
      read($, now),
      read($, usage),
      read($, context),
    ])
    const done = all.filter(x => x.status === 'completed')
    const active = all.filter(x => x.status === 'in_progress')
    const pending = all.filter(x => x.status === 'pending')
    const live = rows.filter(isActive)
    const parked = rows.filter(a => !isFinished(a) && !isActive(a))
    const finished = rows.filter(isFinished).slice(-3)
    const width = Math.max(20, e.props.bodyColumns - 2)
    const clip = (s: string, room = width) => (s.length > room ? `${s.slice(0, room - 1)}…` : s)
    const heading = (s: string) => <Text dimColor bold>{s.toUpperCase()}</Text>

    // One aligned line each: label · bar · figure · short status.
    const meter = (key: string, label: string, fraction: number, figure: string, status: string, tone: Row['tone'] | 'claude') => {
      const [on_, off] = bar(fraction)
      const used = LABEL_WIDTH + BAR + figure.length + 2
      return (
        <Text key={key}>
          <Text bold>{label.padEnd(LABEL_WIDTH)}</Text>
          <Text color={tone}>{on_}</Text>
          <Text color="subtle">{off}</Text>
          <Text bold color={tone}>{` ${figure}`}</Text>
          <Text dimColor>{` ${clip(status, Math.max(4, width - used))}`}</Text>
        </Text>
      )
    }

    const agentRow = (a: AgentRow) => (
      <Box key={`ag-${a.id}`} flexDirection="column">
        <Text color={isActive(a) ? 'claude' : 'subtle'} bold>
          {clip(`${isActive(a) ? '●' : isFinished(a) ? '○' : '◌'} ${a.name}  ${isActive(a) || isFinished(a) ? '' : `${a.status} · `}${formatDuration((a.endedAt ?? t) - a.startedAt)} · ${formatTokens(a.tokens)}`)}
        </Text>
        <Text dimColor>{clip(`  ${a.description || a.type}`)}</Text>
      </Box>
    )

    // The window as one bar, each used category in its /context colour, the free part dim; then the ten
    // biggest consumers, each bar scaled to the biggest.
    const contextSection = (view: ContextView) => {
      const cells = cellsOf([...view.segments.map(s => s.tokens), view.freeTokens], view.usedTokens + view.freeTokens, width)
      const biggest = view.top[0]?.tokens ?? 1
      const nameWidth = Math.max(8, Math.min(18, width - BAR - 12))
      return (
        <Box flexDirection="column">
          {heading(`context · ${view.percent}% · ${formatTokens(view.usedTokens)}/${formatTokens(view.maxTokens)}`)}
          <Text>
            {view.segments.map((s, i) => (
              <Text key={`seg-${i}`} color={s.color}>
                {'█'.repeat(cells[i] ?? 0)}
              </Text>
            ))}
            <Text color="subtle">{'░'.repeat(cells[view.segments.length] ?? 0)}</Text>
          </Text>
          {view.top.map((item, i) => {
            const on_ = Math.max(1, Math.round((item.tokens / biggest) * BAR))
            return (
              <Text key={`top-${i}`}>
                <Text>{clip(item.label, nameWidth).padEnd(nameWidth)}</Text>
                <Text color={item.color}>{` ${'█'.repeat(on_)}`}</Text>
                <Text color="subtle">{'░'.repeat(BAR - on_)}</Text>
                <Text bold>{` ${String(Math.round(item.share * 100)).padStart(3)}%`}</Text>
                <Text dimColor>{` ${formatTokens(item.tokens)}`}</Text>
              </Text>
            )
          })}
          {view.more > 0 && <Text dimColor>{`+${view.more} smaller`}</Text>}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" paddingX={1} gap={1}>
        <Box flexDirection="column">
          {limits.map(r => meter(`u-${r.label}`, r.label, r.percent / 100, `${String(r.percent).padStart(3)}%`, r.brief, r.tone))}
          {meter(
            'tasks',
            'tasks',
            all.length ? done.length / all.length : 0,
            `${done.length}/${all.length}`,
            active.length ? `${active.length} active` : '',
            'success',
          )}
        </Box>

        <Box flexDirection="column">
          {heading(`agents · ${live.length} running${parked.length ? ` · ${parked.length} waiting` : ''}`)}
          {rows.length === 0 ? <Text dimColor>none</Text> : [...live, ...parked, ...finished].map(agentRow)}
        </Box>

        <Box flexDirection="column">
          {heading('now')}
          {running.length === 0 ? (
            <Text dimColor>idle</Text>
          ) : (
            running.map(d => (
              <Text key={`r-${d.id}`} color="warning">
                {clip(`▸ ${d.tool} · ${d.detail}`)}
              </Text>
            ))
          )}
        </Box>

        <Box flexDirection="column">
          {heading('task list')}
          {all.length === 0 && <Text dimColor>none</Text>}
          {active.map(x => (
            <Text key={`a-${x.id}`} color="claude" bold>
              {clip(`◐ ${x.active ?? x.subject}`)}
            </Text>
          ))}
          {pending.map(x => (
            <Text key={`p-${x.id}`}>{clip(`○ ${x.subject}`)}</Text>
          ))}
          {done.length > 0 &&
            (isShowingDone
              ? done.map(x => (
                  <Text key={`d-${x.id}`} dimColor strikethrough>
                    {clip(`● ${x.subject}`)}
                  </Text>
                ))
              : null)}
          <Box flexDirection="row" gap={2}>
            {done.length > 0 && (
              <Button key="toggle-done" plain onPress={() => void update($, showDone, v => !v)}>
                <Text dimColor>{isShowingDone ? 'hide done' : `show ${done.length} done`}</Text>
              </Button>
            )}
          </Box>
        </Box>

        {ctx ? contextSection(ctx) : (
          <Box flexDirection="column">
            {heading('context')}
            <Text dimColor>measuring…</Text>
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: SESSIONS_PANE }, ($, e) => renderSessions($, e))
}
