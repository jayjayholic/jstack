import { atom, read } from 'claude-code'
import type { EngineInterface, RenderInput } from 'claude-code'
import type { AccountView, SessionsView, UsageWindow } from '../types'
import { SWITCH_AT, byNearestReset, effectivePercent, labelOf } from './accounts'
import { describeClass, hasWeeklyLimit, nextWake } from './balance'
import { ensureLoaded, priorityOrder, refreshSessions, setAutoSwitch, switchTo } from './sessions'

const EMPTY: SessionsView = { accounts: [], active: null, autoSwitch: true, refreshing: false, lastSwitch: null, notice: null, error: null, loadedAt: null }
const sessions = atom({ plugin: 'jay-claude-switcher', key: 'sessions' } as const, EMPTY)

const LABEL_WIDTH = 5

function two(n: number): string {
  return String(n).padStart(2, '0')
}

function resetLabel(iso: string | null, now: number): string {
  if (!iso) return ''
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  if (at <= now) return 'reset'
  const d = new Date(at)
  const day = at - now < 24 * 3_600_000 ? '' : `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} `
  return `↻${day}${two(d.getHours())}:${two(d.getMinutes())}`
}

function toneOf(percent: number): 'success' | 'warning' | 'error' {
  return percent >= 90 ? 'error' : percent >= 70 ? 'warning' : 'success'
}

function shortTier(tier: string): string {
  return tier.match(/\d+x/)?.[0] ?? tier
}

async function renderSessions($: EngineInterface, e: RenderInput<'Pane'>) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const [view, now] = await Promise.all([read($, sessions), $.clock.now()])
  if (view.loadedAt == null && !view.refreshing) void ensureLoaded($).catch(() => undefined)
  const width = Math.max(24, e.props.bodyColumns - 2)
  const barWidth = Math.max(8, Math.min(24, width - LABEL_WIDTH - 17))
  const clip = (s: string, room = width) => (s.length > room ? `${s.slice(0, room - 1)}…` : s)

  const meter = (accountKey: string, w: UsageWindow) => {
    const percent = effectivePercent(w, now)
    const cells = Math.max(0, Math.min(barWidth, Math.round((percent / 100) * barWidth)))
    return (
      <Text key={`${accountKey}-${w.key}`}>
        <Text>{`  ${w.label.padEnd(LABEL_WIDTH)}`}</Text>
        <Text color={toneOf(percent)}>{'█'.repeat(cells)}</Text>
        <Text color="subtle">{'░'.repeat(barWidth - cells)}</Text>
        <Text bold color={toneOf(percent)}>{` ${String(Math.round(percent)).padStart(3)}%`}</Text>
        <Text dimColor>{` ${resetLabel(w.resetsAt, now)}`}</Text>
      </Text>
    )
  }

  const current = view.accounts.find(a => a.key === view.active)
  const wake = nextWake(view.accounts, view.active, now)
  const orgsPerEmail = new Map<string, number>()
  for (const a of view.accounts) orgsPerEmail.set(a.email, (orgsPerEmail.get(a.email) ?? 0) + 1)

  const row = (a: AccountView) => {
    const isActive = a.key === view.active
    const head = `(${shortTier(a.tier)}) ${a.email}`
    const org = (orgsPerEmail.get(a.email) ?? 0) > 1 && a.org ? ` ${a.org}` : ''
    return (
      <Box key={`acct-${a.key}`} flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text color={isActive ? 'claude' : undefined} bold={isActive}>
            {clip(head, width - (isActive ? 0 : 8))}
            <Text dimColor bold={false}>
              {clip(org, Math.max(0, width - head.length - (isActive ? 0 : 8)))}
            </Text>
          </Text>
          {!isActive && (
            <Button
              key={`use-${a.key}`}
              label="Use"
              onPress={() =>
                void switchTo($, a.key, labelOf(a), 'manual')
                  .then(() => refreshSessions($, 'none'))
                  .catch(err => $.ui.toast(`Switch failed: ${err instanceof Error ? err.message : 'error'}`))
              }
            />
          )}
        </Box>
        {a.windows.map(w => meter(a.key, w))}
        {hasWeeklyLimit(a) === false && <Text dimColor>{clip(`  ${'week'.padEnd(LABEL_WIDTH)}no weekly limit`)}</Text>}
        {a.error && <Text color="error">{clip(`  ${a.error}`)}</Text>}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" paddingX={1} gap={1}>
      <Box flexDirection="row" gap={2}>
        <Button key="refresh" label={view.refreshing ? 'Refreshing…' : 'Refresh'} onPress={() => void refreshSessions($, 'all').catch(() => undefined)} />
        <Button
          key="auto"
          label={`Auto-switch ${SWITCH_AT}%: ${view.autoSwitch ? 'on' : 'off'}`}
          variant={view.autoSwitch ? 'primary' : 'secondary'}
          onPress={() => void setAutoSwitch($, !view.autoSwitch).catch(() => undefined)}
        />
      </Box>
      {view.error && (
        <Text color="error" wrap="wrap">
          {view.error}
        </Text>
      )}
      {view.notice && (
        <Text key="notice" color={view.notice.startsWith('Auto-switch: no') ? 'warning' : undefined} wrap="wrap">
          {view.notice}
        </Text>
      )}
      {current && (
        <Text key="chosen" wrap="wrap">
          <Text bold>{'Why this one: '}</Text>
          <Text dimColor>{view.chosen ?? `${describeClass(current, priorityOrder())} (not switched by the balancer yet)`}</Text>
        </Text>
      )}
      {wake && (
        <Text key="wake" dimColor>
          {clip(`Next wake-up: ${resetLabel(new Date(wake.at).toISOString(), now)} ${wake.key.split('#')[0]} ${wake.window}`)}
        </Text>
      )}
      {view.accounts.length === 0 && !view.error && <Text dimColor>{view.refreshing || view.loadedAt == null ? 'Reading accounts…' : 'No stored accounts.'}</Text>}
      {byNearestReset(view.accounts, now).map(row)}
    </Box>
  )
}

export { renderSessions }
