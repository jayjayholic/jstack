import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { ReadSchedule, ReadWhich, SessionsView } from '../types'
import { ACTIVE_READ_MS, CANDIDATE_READ_MS, isSwitchDue, isWatched, markLimitHit, noTargetReason, switchTarget, withSessionLimits } from './accounts'
import { importAccount, ioOf, readAccounts, switchAccount } from './account-io'

const AUTO_KEY = 'auto-switch'
const SWITCH_COOLDOWN_MS = 90_000
// A limit error this soon after a switch came from a request still in flight on the old login.
const LIMIT_HIT_GRACE_MS = 15_000
const RESTART_NOTE =
  'Running sessions use it from their next request, no restart (they re-read .credentials.json when it changes); /status may show the old email until restart. If one shows an auth error, restart it.'

const EMPTY: SessionsView = { accounts: [], active: null, autoSwitch: true, refreshing: false, lastSwitch: null, notice: null, error: null, loadedAt: null }
const sessions = atom({ plugin: 'jay-claude-switcher', key: 'sessions' } as const, EMPTY)

const schedule: ReadSchedule = { readAt: new Map(), backoff: new Map() }
let busy = false
let inFlight: Promise<void> | null = null

function readRunning(): boolean {
  return inFlight !== null
}

// One read at a time: a caller that finds one running waits for it, and one that asks the network then reads again.
async function refreshSessions($: EngineInterface, which: ReadWhich): Promise<void> {
  if (inFlight) {
    await inFlight.catch(() => undefined)
    if (which === 'none' || readRunning()) return
  }
  const run = readOnce($, which)
  inFlight = run
  try {
    await run
  } finally {
    if (inFlight === run) inFlight = null
  }
}

async function readOnce($: EngineInterface, which: ReadWhich): Promise<void> {
  await update($, sessions, v => ({ ...v, refreshing: true }))
  try {
    const previous = (await read($, sessions)).accounts
    const autoSwitch = await $.store.get(AUTO_KEY).catch(() => undefined)
    const { accounts, active } = await readAccounts(ioOf($), previous, schedule, which)
    const at = await $.clock.now()
    await update($, sessions, v => ({ ...v, accounts, active, autoSwitch: autoSwitch !== false, error: null, loadedAt: at }))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const at = await $.clock.now().catch(() => 0)
    await update($, sessions, v => ({ ...v, error: `Could not read the accounts: ${message}`.slice(0, 300), loadedAt: at }))
    throw err
  } finally {
    await update($, sessions, v => ({ ...v, refreshing: false }))
  }
}

async function switchTo($: EngineInterface, key: string, label: string, reason: string, expectFrom?: string | null): Promise<boolean> {
  const { from, switched } = await switchAccount(ioOf($), key, expectFrom)
  const at = await $.clock.now()
  if (!switched) {
    await update($, sessions, v => ({ ...v, active: from, notice: `The login changed elsewhere to ${from?.split('#')[0]}; no switch made.` }))
    return false
  }
  await update($, sessions, v => ({ ...v, active: key, lastSwitch: { from, to: key, at, reason }, notice: `Now using ${label}. ${RESTART_NOTE}` }))
  $.ui.toast(`Now using ${label}`)
  return true
}

async function importFrom($: EngineInterface, folder?: string): Promise<void> {
  const label = await importAccount(ioOf($), folder)
  await update($, sessions, v => ({ ...v, notice: `Imported ${label}.` }))
}

// `limitHit`: the session itself was refused for its limit, so the usual 90 s pause after a switch shrinks to 15 s.
async function autoSwitchTick($: EngineInterface, limitHit = false): Promise<void> {
  const view = await read($, sessions)
  if (!view.autoSwitch || busy) return
  if (inFlight) await inFlight.catch(() => undefined)
  const now = await $.clock.now()
  const pause = limitHit ? LIMIT_HIT_GRACE_MS : SWITCH_COOLDOWN_MS
  if (view.lastSwitch && now - view.lastSwitch.at < pause) return
  if (!isSwitchDue(view.accounts.find(a => a.key === view.active), now)) return
  busy = true
  try {
    // A switch is due: the other accounts are asked once (not again within 5 minutes) to pick the target.
    const stale = view.accounts
      .filter(a => a.key !== view.active && now - (schedule.readAt.get(a.key) ?? 0) >= CANDIDATE_READ_MS && now >= (schedule.backoff.get(a.key)?.until ?? 0))
      .map(a => a.key)
    if (stale.length) await refreshSessions($, stale).catch(() => undefined)
    const fresh = await read($, sessions)
    const at = await $.clock.now()
    const target = switchTarget(fresh.accounts, fresh.active, at)
    if (!target) {
      const notice = noTargetReason(fresh.accounts, fresh.active, at)
      if (fresh.notice !== notice) await update($, sessions, v => ({ ...v, notice }))
      return
    }
    await switchTo($, target.to, target.label, `auto: ${target.reason}`, fresh.active)
  } finally {
    busy = false
  }
  await refreshSessions($, 'none').catch(() => undefined)
}

// The first draw of the tab, and a reload, find nothing read yet: read once, without forcing.
async function ensureLoaded($: EngineInterface): Promise<void> {
  const view = await read($, sessions)
  if (view.loadedAt == null && !inFlight) await refreshSessions($, 'none')
}

function summaryOf(view: SessionsView): string {
  if (view.error) return view.error
  if (!view.accounts.length) return 'No stored accounts.'
  return view.accounts
    .map((a, i) => {
      const windows = a.windows.map(w => `${w.label} ${Math.round(w.percent)}%`).join(', ')
      return `${a.key === view.active ? '*' : ' '} ${i} ${a.email} (${a.tier}${a.org ? `, ${a.org}` : ''}): ${a.error ?? (windows || 'no reading')}`
    })
    .join('\n')
}

async function sessionsReport($: EngineInterface): Promise<string> {
  await refreshSessions($, 'all').catch(() => undefined)
  return summaryOf(await read($, sessions))
}

// No background reads below 98%: the session's own headers keep the current account up to date for free. From 98%
// the current account is asked at most once a minute, and never while it backs off after a failure.
async function backgroundRefresh($: EngineInterface): Promise<void> {
  const view = await read($, sessions)
  if (!view.autoSwitch || view.loadedAt == null || !view.active || busy || inFlight) return
  const now = await $.clock.now()
  if (!isWatched(view.accounts.find(a => a.key === view.active), now)) return
  if (now - (schedule.readAt.get(view.active) ?? 0) < ACTIVE_READ_MS) return
  if (now < (schedule.backoff.get(view.active)?.until ?? 0)) return
  await refreshSessions($, [view.active])
}

// Every request's rate-limit headers update the current account at once; reaching 98% starts the minute reads.
async function noteSessionLimits($: EngineInterface, limits: readonly { kind: string; percentUsed: number; resetsAt?: string }[]): Promise<void> {
  const view = await read($, sessions)
  const active = view.accounts.find(a => a.key === view.active)
  if (!active) return
  const windows = withSessionLimits(active.windows, limits)
  await update($, sessions, v => ({ ...v, accounts: v.accounts.map(a => (a.key === active.key ? { ...a, windows } : a)) }))
  if (isSwitchDue({ ...active, windows }, await $.clock.now())) void autoSwitchTick($).catch(() => undefined)
}

// A turn ended on an API error (StopFailure does not say which, for an agent's turn): when the current account was
// already at 98% or more, that error is taken as its limit.
async function noteTurnError($: EngineInterface, limits: readonly { kind: string; percentUsed: number; resetsAt?: string }[]): Promise<void> {
  await noteSessionLimits($, limits)
  const view = await read($, sessions)
  if (isWatched(view.accounts.find(a => a.key === view.active), await $.clock.now())) await noteLimitHit($, '')
}

// A request of this session (or one of its agents) was refused for the account's limit: switch on the error itself,
// without waiting for any reading to say so.
async function noteLimitHit($: EngineInterface, details: string): Promise<void> {
  const view = await read($, sessions)
  const active = view.accounts.find(a => a.key === view.active)
  if (!active) return
  const now = await $.clock.now()
  const windows = markLimitHit(active.windows, details, now)
  await update($, sessions, v => ({ ...v, accounts: v.accounts.map(a => (a.key === active.key ? { ...a, windows } : a)) }))
  await autoSwitchTick($, true)
}

async function setAutoSwitch($: EngineInterface, on: boolean): Promise<void> {
  await $.store.set(AUTO_KEY, on)
  await update($, sessions, v => ({ ...v, autoSwitch: on }))
  if (on) await refreshSessions($, 'none')
}

async function loadAutoSwitch($: EngineInterface): Promise<void> {
  const saved = await $.store.get(AUTO_KEY).catch(() => undefined)
  const on = saved !== false
  if (saved === undefined) await $.store.set(AUTO_KEY, true).catch(() => undefined)
  await update($, sessions, v => ({ ...v, autoSwitch: on }))
}

export { autoSwitchTick, backgroundRefresh, ensureLoaded, importFrom, loadAutoSwitch, noteLimitHit, noteSessionLimits, noteTurnError, refreshSessions, sessionsReport, setAutoSwitch, switchTo }
