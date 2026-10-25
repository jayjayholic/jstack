import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { AccountView, ReadSchedule, ReadWhich, SessionWindow, SessionsView } from '../types'
import { ACTIVE_READ_MS, CANDIDATE_READ_MS, SWITCH_AT, isNearLimit, isSwitchDue, isWatched, leastUsed, markLimitHit, noTargetReason, peakOf, switchTarget, withSessionLimits } from './accounts'
import { importAccount, ioOf, readAccounts, readPriority, switchAccount, writeTrace } from './account-io'
import { balanceTarget, wokenUp, type Pick } from './balance'

const AUTO_KEY = 'auto-switch'
const SWITCH_COOLDOWN_MS = 90_000
// A limit error this soon after a switch came from a request still in flight on the old login.
const LIMIT_HIT_GRACE_MS = 15_000
const RESTART_NOTE =
  'Running sessions use it from their next request, no restart (they re-read .credentials.json when it changes); /status may show the old email until restart. If one shows an auth error, restart it.'

const EMPTY: SessionsView = { accounts: [], active: null, autoSwitch: true, refreshing: false, lastSwitch: null, notice: null, error: null, loadedAt: null }
const sessions = atom({ plugin: 'jay-claude-switcher', key: 'sessions' } as const, EMPTY)

const schedule: ReadSchedule = { readAt: new Map(), backoff: new Map() }
// A switch stuck this long (a hung write) no longer blocks the next one.
const BUSY_STUCK_MS = 30_000
// A due switch with nothing cached to go to waits this long for the candidates' reads, no more.
const CANDIDATE_WAIT_MS = 4_000
// After a switch, readings that still carry the old account's windows (requests sent before it) are not the new one's.
const OLD_READING_MS = 10 * 60_000
const TRACE_LINES = 400
// A freed swap waits this long after any switch, so readings settle first.
const FREED_GRACE_MS = 15_000
// A freed account whose reading is older than this is read once before the swap.
const FREED_CONFIRM_MS = 60_000
// Every other account is read this often in the background (every 5 minutes from 95% on the current one).
const OTHERS_READ_MS = 10 * 60_000
let busySince: number | null = null
// The owner's override of the balancer's order (priority.json), read with every account read.
let priority: string[] = []
let inFlight: Promise<void> | null = null
// The last rate-limit reading the session reported for the current account.
let sessionLimits: SessionWindow[] = []
let oldReading: { windows: Set<string>; until: number } | null = null
let trace: string[] = []
let traceDirty = false
let lastDecision = ''
let lastReading = ''

// One timestamped line per reading, decision and switch, the last 400 kept in ~/.claude/logins/switch-trace.log.
// Emails, percents and reasons only: never a token.
async function traced($: EngineInterface, event: string, detail: string): Promise<void> {
  const at = await $.clock.now().catch(() => 0)
  trace = [...trace, `${new Date(at).toISOString()} ${event} ${detail}`].slice(-TRACE_LINES)
  traceDirty = true
}

async function flushTrace($: EngineInterface): Promise<void> {
  if (!traceDirty) return
  traceDirty = false
  await writeTrace(ioOf($), `${trace.join('\n')}\n`).catch(() => undefined)
}

function emailOf(key: string | null | undefined): string {
  return key ? key.split('#')[0]! : 'none'
}

function windowIds(limits: readonly SessionWindow[]): string[] {
  return limits.map(l => `${l.kind}@${l.resetsAt ?? ''}`)
}

function isBusy(now: number): boolean {
  return busySince !== null && now - busySince < BUSY_STUCK_MS
}

function withinMs<T>($: EngineInterface, work: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([work, $.clock.sleep(ms).then(() => undefined)])
}

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
    const started = await $.clock.now()
    const previous = (await read($, sessions)).accounts
    const autoSwitch = await $.store.get(AUTO_KEY).catch(() => undefined)
    priority = await readPriority(ioOf($)).catch(() => priority)
    const { accounts, active } = await readAccounts(ioOf($), previous, schedule, which)
    const at = await $.clock.now()
    await update($, sessions, v => {
      // A switch made while this read ran wins over the login the read found; the session's own reading, fresher
      // than a usage answer, stays laid over the current account's.
      const current = v.lastSwitch && v.lastSwitch.at >= started ? v.active : active
      const merged = accounts.map(a => (a.key === current ? { ...a, windows: withSessionLimits(a.windows, sessionLimits) } : a))
      return { ...v, accounts: merged, active: current, autoSwitch: autoSwitch !== false, error: null, loadedAt: at }
    })
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
  oldReading = { windows: new Set(windowIds(sessionLimits)), until: at + OLD_READING_MS }
  sessionLimits = []
  await update($, sessions, v => ({ ...v, active: key, lastSwitch: { from, to: key, at, reason }, chosen: reason, notice: `Now using ${label}. ${RESTART_NOTE}` }))
  $.ui.toast(`Now using ${label}`)
  return true
}

async function importFrom($: EngineInterface, folder?: string): Promise<void> {
  const label = await importAccount(ioOf($), folder)
  await update($, sessions, v => ({ ...v, notice: `Imported ${label}.` }))
}

// Other accounts due a read: older than `everyMs`, or whose window reset since their last read (the wake-up), and
// not backing off after a failure.
function staleCandidates(view: SessionsView, now: number, everyMs: number): string[] {
  return view.accounts
    .filter(a => a.key !== view.active && now >= (schedule.backoff.get(a.key)?.until ?? 0) && (wokenUp(a, now) || now - (schedule.readAt.get(a.key) ?? 0) >= everyMs))
    .map(a => a.key)
}

async function decided($: EngineInterface, current: AccountView | undefined, now: number, due: boolean, note: string): Promise<void> {
  const peak = current ? peakOf(current, now) : null
  const line = `account=${emailOf(current?.key)} peak=${peak ?? 'none'} threshold=${SWITCH_AT} due=${due}${note ? ` ${note}` : ''}`
  if (line === lastDecision) return
  lastDecision = line
  await traced($, 'decide', line)
}

// The balancer swaps for exactly two reasons (balance.ts): the current account ran out in its window (`due`: the 99%
// check or a limit error), or a free account of a strictly better priority class exists (`freed`). A due swap goes
// out on the readings in hand, never waiting for a usage read, so it lands within the 1 s check of the reading that
// made it due; only with no account read below 99% does it ask the candidates, for a few seconds at most. A freed
// swap is not urgent: the freed account is read once first to confirm it.
// `limitHit`: the session itself was refused for its limit, so the usual 90 s pause after a switch shrinks to 15 s.
async function autoSwitchTick($: EngineInterface, limitHit = false): Promise<void> {
  const view = await read($, sessions)
  const now = await $.clock.now()
  if (!view.autoSwitch || isBusy(now)) return
  const current = view.accounts.find(a => a.key === view.active)
  const due = isSwitchDue(current, now)
  const freed = due ? null : balanceTarget(view.accounts, view.active, now, priority, false)
  const sinceSwitch = view.lastSwitch ? now - view.lastSwitch.at : Number.POSITIVE_INFINITY
  const cooling = sinceSwitch < (due ? (limitHit ? LIMIT_HIT_GRACE_MS : SWITCH_COOLDOWN_MS) : FREED_GRACE_MS)
  const note = [limitHit && 'limit-hit', freed && `freed=${emailOf(freed.to)}`, (due || freed) && cooling && 'cooldown'].filter(Boolean).join(' ')
  await decided($, current, now, due, note)
  if ((!due && !freed) || cooling) return void (await flushTrace($))
  busySince = now
  let moved: string | null = null
  try {
    let target: Pick | { to: string; label: string; reason: string } | null = null
    if (due) {
      target = balanceTarget(view.accounts, view.active, now, priority, true) ?? (leastUsed(view.accounts, view.active, now) ? switchTarget(view.accounts, view.active, now) : null)
      if (!target) {
        const stale = staleCandidates(view, now, CANDIDATE_READ_MS)
        await traced($, 'candidates', `no cached target, reading ${stale.length}`)
        if (stale.length) await withinMs($, refreshSessions($, stale).catch(() => undefined), CANDIDATE_WAIT_MS)
        const fresh = await read($, sessions)
        const at = await $.clock.now()
        target = balanceTarget(fresh.accounts, fresh.active, at, priority, true) ?? switchTarget(fresh.accounts, fresh.active, at)
        if (!target) {
          const notice = noTargetReason(fresh.accounts, fresh.active, at)
          await traced($, 'no-target', notice)
          if (fresh.notice !== notice) await update($, sessions, v => ({ ...v, notice }))
          return
        }
      }
    } else if (freed) {
      const known = view.accounts.find(a => a.key === freed.to)
      if (!known?.fetchedAt || now - known.fetchedAt > FREED_CONFIRM_MS) await withinMs($, refreshSessions($, [freed.to]).catch(() => undefined), CANDIDATE_WAIT_MS)
      const fresh = await read($, sessions)
      target = balanceTarget(fresh.accounts, fresh.active, await $.clock.now(), priority, false)
      if (!target) {
        await traced($, 'freed-gone', `${emailOf(freed.to)} is not free after a fresh read`)
        return
      }
    }
    if (!target) return
    const kind = due ? 'out' : 'freed'
    const ok = await switchTo($, target.to, target.label, `auto (${kind}): ${target.reason}`, view.active)
    if (ok) moved = target.to
    await traced($, 'switch', `trigger=${kind} from=${emailOf(view.active)} to=${emailOf(target.to)} reason="${target.reason}" switched=${ok} took=${(await $.clock.now()) - now}ms`)
  } catch (err) {
    await traced($, 'switch-failed', (err instanceof Error ? err.message : 'failed').slice(0, 120))
  } finally {
    busySince = null
    await flushTrace($)
  }
  // After a switch the new account is read at once, so the next decision stands on its own numbers.
  void refreshSessions($, moved ? [moved] : 'none').catch(() => undefined)
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
  const now = await $.clock.now()
  if (!view.autoSwitch || view.loadedAt == null || !view.active || isBusy(now) || inFlight) return
  // The others every 10 minutes, and at once after one of their windows reset; from 95% on the current account they
  // are read every 5 minutes and the current one every 5 s, so the switch at 99% has its target in hand.
  const watched = isWatched(view.accounts.find(a => a.key === view.active), now)
  const activeDue = watched && now - (schedule.readAt.get(view.active) ?? 0) >= ACTIVE_READ_MS && now >= (schedule.backoff.get(view.active)?.until ?? 0)
  const keys = [...(activeDue ? [view.active] : []), ...staleCandidates(view, now, watched ? CANDIDATE_READ_MS : OTHERS_READ_MS)]
  if (keys.length) await refreshSessions($, keys)
}

// Every request's rate-limit headers update the current account at once (a lagging usage answer never lowers them);
// a reading that still carries only the old account's windows right after a switch is dropped. `check`: run the
// switch check now (the 1 s poll runs it itself).
async function noteSessionLimits($: EngineInterface, limits: readonly SessionWindow[], check = true): Promise<void> {
  const now = await $.clock.now()
  const old = oldReading
  if (old && now < old.until && limits.length && windowIds(limits).every(id => old.windows.has(id))) return
  const shown = limits.map(l => `${l.kind}=${l.percentUsed}`).join(' ')
  if (shown !== lastReading) {
    lastReading = shown
    await traced($, 'reading', shown || 'none')
  }
  if (limits.length) sessionLimits = [...limits]
  const view = await read($, sessions)
  const active = view.accounts.find(a => a.key === view.active)
  if (!active) return
  const windows = withSessionLimits(active.windows, sessionLimits)
  await update($, sessions, v => ({ ...v, accounts: v.accounts.map(a => (a.key === active.key ? { ...a, windows } : a)) }))
  if (check && isSwitchDue({ ...active, windows }, now)) void autoSwitchTick($).catch(() => undefined)
}

// The 1 s check: the session's own figures (free, no request) first, so a 99% that any response reported (the main
// loop's, a subagent's, a workflow agent's) is acted on within a second even when no hook carried it.
async function switchPoll($: EngineInterface): Promise<void> {
  const { rateLimits } = await $.session.usage()
  await noteSessionLimits($, rateLimits as SessionWindow[], false)
  await autoSwitchTick($)
}

// A turn ended on an API error (StopFailure does not say which, for an agent's turn): when the current account was
// already at 98% or more, that error is taken as its limit. Says whether it was.
async function noteTurnError($: EngineInterface, limits: readonly { kind: string; percentUsed: number; resetsAt?: string }[]): Promise<boolean> {
  await noteSessionLimits($, limits)
  const view = await read($, sessions)
  if (!isNearLimit(view.accounts.find(a => a.key === view.active), await $.clock.now())) return false
  await noteLimitHit($, '')
  return true
}

// The account the session is on now, as the tab labels it.
async function activeLabel($: EngineInterface): Promise<string | null> {
  const view = await read($, sessions)
  const a = view.accounts.find(x => x.key === view.active)
  return a ? `${a.email}${a.org ? ` [${a.org}]` : ''}` : null
}

async function setNotice($: EngineInterface, notice: string): Promise<void> {
  await update($, sessions, v => ({ ...v, notice }))
}

// A request of this session (or one of its agents) was refused for the account's limit: switch on the error itself,
// without waiting for any reading to say so.
async function noteLimitHit($: EngineInterface, details: string): Promise<void> {
  const view = await read($, sessions)
  const active = view.accounts.find(a => a.key === view.active)
  if (!active) return
  const now = await $.clock.now()
  await traced($, 'limit-hit', `account=${emailOf(active.key)} details="${details.slice(0, 80)}"`)
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

function priorityOrder(): readonly string[] {
  return priority
}

export { autoSwitchTick, priorityOrder, switchPoll, backgroundRefresh, ensureLoaded, importFrom, loadAutoSwitch, activeLabel, setNotice, noteLimitHit, noteSessionLimits, noteTurnError, refreshSessions, sessionsReport, setAutoSwitch, switchTo }
