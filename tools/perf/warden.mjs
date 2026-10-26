// The warden: deterministic actions the collector takes every tick, with no LLM and no human in the loop, limited to
// things that don't get in anyone's way. Each action is appended to actions.jsonl (what, why, before, after): that log
// is its memory. Policy functions are pure (tested); runWarden() applies them and never throws into the collector.
//   - kill orphaned dev processes: parent gone, a known dev tool, old enough (and idle, for servers and browsers),
//     never protected: claude, MCP, docker/WSL, editors, jstack's own tools, the heavy-lock holder's worktree, a
//     keep-browser marker, anything with a protected descendant, anything whose command line couldn't be read
//   - run the RAM clean task when available RAM is low (shared cooldown with ram-clean.ps1)
//   - flag hung tests (90%+ of a core for 15+ min) to notices.jsonl, never kill them
//   - kill a hung heavy dev tool (tsc/tsgo/next build/esbuild: zero CPU for 15+ min, 2+ GB private); if it survives
//     10 s, kill its node/bun launcher (a native child of a launcher can't be terminated while the parent holds it)
//   - stop an idle Docker Compose project (no container CPU, no client connected, no eval process) after 30+ min
//   - write triggers (ram-low, hung, new top consumer, new heavy process name, regression above the floor) that tell
//     the orchestrator when an optimizer agent is worth spawning
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const SHORT_TOOLS = new Set(['grep', 'rg', 'find', 'xargs', 'tail', 'sleep', 'tsc', 'tsgo', 'esbuild'])
const SERVER_TOOLS = new Set(['node', 'bun'])
const BROWSERS = new Set(['chrome-headless-shell', 'chrome', 'msedge', 'chromium'])
const PROTECT_RE = /claude|@anthropic|anthropic-ai|[\\/]mcp|mcp-server|modelcontextprotocol|\bmcp\b|docker|vmmem|wsl|harness-eval|eval-env|mem-map|idle-reaper|node-memory-watch|ram-clean|heavy-lock|run-capped|collect\.mjs|perf\.mjs|jstack-|vscode|code\.exe|cursor|windsurf|language-?server|tsserver|typingsInstaller/i

const DEFAULTS = {
  mode: 'act', orphanShortMin: 10, orphanIdleMin: 30, idleCpuPct: 1, maxKillsPerTick: 10,
  ramCleanBelowPct: 10, ramCleanCooldownMin: 10, ramCleanTask: process.env.JSTACK_RAM_CLEAN_TASK ?? 'JstackRamClean',
  hungCpuPct: 90, hungMin: 15, hungToolMin: 15, hungToolPrivMb: 2048, hungToolWaitMs: 10000, protect: '', triggerCooldownMin: 30,
  docker: { project: '', idleMin: 30, cpuPct: 2, checkEveryMin: 5, busyPattern: '' },
}

function wardenConfig(cfg = {}) {
  const w = cfg.warden ?? {}
  return { ...DEFAULTS, ...w, docker: { ...DEFAULTS.docker, ...(w.docker ?? {}) } }
}

const base = n => String(n).toLowerCase().replace(/\.exe$/, '')

function childrenMap(procs) {
  const kids = new Map()
  for (const p of procs) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p) }
  return kids
}

function treeOf(root, kids, parent) {
  const out = []
  const stack = [root]
  while (stack.length) {
    const p = stack.pop()
    out.push(p)
    for (const c of kids.get(p.pid) ?? []) if (parent.get(c.pid) === p) stack.push(c)
  }
  return out
}

function isProtected(p, { selfPid, protectRe, lockWts, keepPids }) {
  if (p.pid === selfPid || p.pid <= 4 || keepPids.has(p.pid)) return 'self, system or keep marker'
  if (base(p.name) === 'claude' || p.kind === 'claude' || p.kind === 'mcp') return 'agent CLI or MCP'
  if (!p.cmd) return 'command line unreadable'
  if (protectRe.test(p.cmd) || protectRe.test(p.name)) return 'protected pattern'
  const cmd = p.cmd.toLowerCase()
  for (const wt of lockWts) if (wt && (p.wt?.toLowerCase() === wt || cmd.includes(wt) || cmd.includes(wt.replace(/\\/g, '/')))) return 'heavy-lock holder worktree'
  return null
}

// Orphaned dev processes that may be killed now. procs carry kind/wt/cmd (attribute()) and ageMin; activity:
// Map key -> { lastBusyAt } maintained by trackActivity().
function decideKills(procs, parent, { now, cfg, selfPid = process.pid, locks = [], keepPids = new Set(), activity = new Map() }) {
  const w = cfg
  const protectRe = w.protect ? new RegExp(`${PROTECT_RE.source}|${w.protect}`, 'i') : PROTECT_RE
  const lockWts = locks.map(l => String(l[3] ?? '').toLowerCase()).filter(Boolean)
  const kids = childrenMap(procs)
  const ctx = { selfPid, protectRe, lockWts, keepPids }
  const out = []
  for (const p of procs) {
    if (out.length >= w.maxKillsPerTick) break
    if (!p.ppid || parent.has(p.pid)) continue
    const n = base(p.name)
    const short = SHORT_TOOLS.has(n)
    const server = SERVER_TOOLS.has(n)
    const browser = BROWSERS.has(n) && p.kind === 'browser'
    if (!short && !server && !browser) continue
    // servers only inside an agent worktree: a main checkout's dev server is the human's local app
    if (server && !/[\\/]\.?worktrees[\\/]/i.test(p.wt ?? '')) continue
    if (!(p.ageMin >= (short ? w.orphanShortMin : w.orphanIdleMin))) continue
    const tree = treeOf(p, kids, parent)
    let blocked = null
    for (const t of tree) { blocked = isProtected(t, ctx); if (blocked) break }
    if (blocked) continue
    if (!short) {
      const busy = tree.some(t => (t.cpuNow ?? 0) >= w.idleCpuPct || now - (activity.get(`${t.pid}:${t.create}`)?.lastBusyAt ?? 0) < w.orphanIdleMin * 60000)
      if (busy) continue
    }
    out.push({
      pid: p.pid, create: p.create, name: p.name, kind: p.kind, wt: p.wt, ageMin: p.ageMin, cmd: p.cmd, tree: tree.map(t => t.pid).reverse(),
      privMb: Math.round(tree.reduce((s, t) => s + t.priv, 0) / 1048576), cpu: Math.round(tree.reduce((s, t) => s + (t.cpuNow ?? 0), 0) * 10) / 10,
      why: short ? `orphaned ${n}, parent gone, ${p.ageMin} min old (nobody reads its output)` : `orphaned ${browser ? 'automation browser' : n}, parent gone, idle ${w.orphanIdleMin}+ min, ${p.ageMin} min old`,
    })
  }
  return out
}

// lastBusyAt per process key (first sighting counts as busy, so a fresh process always gets the full idle window).
function trackActivity(procs, activity, now, idleCpuPct = 1) {
  const live = new Set()
  for (const p of procs) {
    const k = `${p.pid}:${p.create}`
    live.add(k)
    const a = activity.get(k)
    if (!a) activity.set(k, { lastBusyAt: now, highSince: (p.cpuNow ?? 0) >= 90 ? now : null })
    else {
      if ((p.cpuNow ?? 0) >= idleCpuPct) a.lastBusyAt = now
      a.highSince = (p.cpuNow ?? 0) >= 90 ? (a.highSince ?? now) : null
    }
  }
  for (const k of activity.keys()) if (!live.has(k)) activity.delete(k)
  return activity
}

function isTest(p) { return p.kind === 'tests' || /\b(bun|npx|node|pnpm|yarn)\b.*\btest\b|vitest|jest|playwright\s+test|pytest/i.test(p.cmd ?? '') }

function decideHung(procs, activity, { now, cfg, noticed = new Set() }) {
  const out = []
  for (const p of procs) {
    const k = `${p.pid}:${p.create}`
    const a = activity.get(k)
    if (!a?.highSince || noticed.has(k) || !isTest(p)) continue
    const min = (now - a.highSince) / 60000
    if (min >= cfg.hungMin) out.push({ key: k, pid: p.pid, name: p.name, wt: p.wt, minutes: Math.round(min), cpu: p.cpuNow, cmd: p.cmd })
  }
  return out
}

function decideRamClean(m, { now, cfg, lastRunAt = 0 }) {
  if (!cfg.ramCleanTask || !m?.totalMb) return null
  const limitMb = (m.totalMb * cfg.ramCleanBelowPct) / 100
  if (m.availMb >= limitMb) return null
  if (now - lastRunAt < cfg.ramCleanCooldownMin * 60000) return null
  return { why: `available ${m.availMb} MB < ${Math.round(limitMb)} MB (${cfg.ramCleanBelowPct}% of RAM)` }
}

// Docker Compose project idle stop: decide from what was observed, never from a single sample.
function decideDockerStop(obs, { now, cfg, startedAt }) {
  const d = cfg.docker
  if (!d.project || !obs?.running) return null
  if (now - startedAt < d.idleMin * 60000) return null
  if (now - (obs.lastActiveAt ?? 0) < d.idleMin * 60000) return null
  return { why: `${d.project}: no container above ${d.cpuPct}% CPU, no client connected and no eval process for ${d.idleMin}+ min` }
}

// Trigger keys with a cooldown so one condition doesn't flood the orchestrator.
function shouldTrigger(state, type, key, now, cooldownMin) {
  const k = `${type}|${key}`
  if (now - (state.lastTrigger?.[k] ?? 0) < cooldownMin * 60000) return false
  state.lastTrigger = state.lastTrigger ?? {}
  state.lastTrigger[k] = now
  return true
}

// New names in the rolling top 5 (CPU or RAM) over the last 15 ticks; the first 15 ticks only learn.
function topTriggers(record, state, now) {
  state.window = state.window ?? []
  state.window.push(record.g.map(r => [r[0], r[3], r[4]]))
  if (state.window.length > 15) state.window.shift()
  state.knownTop = state.knownTop ?? []
  const known = new Set(state.knownTop)
  const sum = new Map()
  for (const tick of state.window) for (const [name, cpu, mb] of tick) {
    if (name === '_small') continue
    const s = sum.get(name) ?? { cpu: 0, mb: 0 }
    s.cpu += cpu / state.window.length; s.mb += mb / state.window.length
    sum.set(name, s)
  }
  const rows = [...sum.entries()]
  const top = new Set([...rows.sort((a, b) => b[1].cpu - a[1].cpu).slice(0, 5), ...rows.sort((a, b) => b[1].mb - a[1].mb).slice(0, 5)].map(r => r[0]))
  const fresh = [...top].filter(n => !known.has(n))
  for (const n of fresh) state.knownTop.push(n)
  if (state.window.length < 15 && !state.learned) return []
  state.learned = true
  return fresh.map(n => ({ type: 'new-top-consumer', key: n, detail: `${n}: ${Math.round(sum.get(n).cpu)}% of a core, ${Math.round(sum.get(n).mb)} MB over 15 min` }))
}

const HEAVY_TOOL_NAMES = new Set(['tsc', 'tsgo', 'esbuild'])
const HEAVY_TOOL_CMD = /[\/]bin[\/](tsc|tsgo)|tsgo|esbuild|next(.js)?["']?s+build|[\/]next[\/]dist[\/]bin[\/]next["']?s+build/i
const LAUNCHERS = new Set(['node', 'bun'])
const SHELLS = new Set(['bash', 'sh', 'cmd', 'powershell', 'pwsh', 'zsh', 'conhost'])

function isHeavyTool(p) { return HEAVY_TOOL_NAMES.has(base(p.name)) || HEAVY_TOOL_CMD.test(p.cmd ?? '') }

// Why the launcher above a hung tool must be left alone, or null when it may be killed.
function parentBlock(par, procs, ctx) {
  if (!par) return 'parent gone'
  if (!LAUNCHERS.has(base(par.name))) return SHELLS.has(base(par.name)) ? 'parent is a shell' : 'parent is not a node/bun launcher'
  const blocked = isProtected(par, ctx)
  if (blocked) return blocked
  const others = procs.filter(c => c.ppid === par.pid && !HEAVY_TOOL_NAMES.has(base(c.name)) && !/^conhost/i.test(c.name))
  if (others.length) return 'parent holds other children'
  return null
}

// A heavy dev tool with no CPU progress for hungToolMin and over hungToolPrivMb private: hung, holding RAM for nothing.
function decideHungTools(procs, parent, activity, { now, cfg, selfPid = process.pid, keepPids = new Set() }) {
  const protectRe = cfg.protect ? new RegExp(`${PROTECT_RE.source}|${cfg.protect}`, 'i') : PROTECT_RE
  const ctx = { selfPid, protectRe, lockWts: [], keepPids }
  const out = []
  for (const p of procs) {
    if (!isHeavyTool(p) || (p.priv ?? 0) < cfg.hungToolPrivMb * 1048576 || (p.cpuNow ?? 0) >= cfg.idleCpuPct) continue
    const a = activity.get(`${p.pid}:${p.create}`)
    if (!a || now - a.lastBusyAt < cfg.hungToolMin * 60000) continue
    if (isProtected(p, ctx)) continue
    const par = parent.get(p.pid)
    out.push({ pid: p.pid, create: p.create, name: p.name, wt: p.wt, cmd: p.cmd, privMb: Math.round(p.priv / 1048576), idleMin: Math.round((now - a.lastBusyAt) / 60000),
      parent: par ? { pid: par.pid, name: par.name, cmd: par.cmd, privMb: Math.round((par.priv ?? 0) / 1048576) } : null, parentBlock: parentBlock(par, procs, ctx) })
  }
  return out
}

function alive(pid) { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

function floorTrigger(state, floor) {
  if (!floor?.cpu || (state.window?.length ?? 0) < 15) return null
  const mean = state.machineWindow.reduce((s, x) => s + x, 0) / state.machineWindow.length
  const limit = floor.cpu.p75 + 15
  return mean > limit ? { type: 'regression', key: 'machine-cpu', detail: `machine CPU ${Math.round(mean)}% over 15 min, floor p75 ${floor.cpu.p75}%` } : null
}

// ---------- effects (I/O) ----------

function appendJsonl(file, rec) { fs.appendFileSync(file, `${JSON.stringify(rec)}\n`) }

function keepMarkers(now) {
  const dir = path.join(os.homedir(), '.jstack', 'keep-browser')
  const out = new Set()
  try { for (const f of fs.readdirSync(dir)) { const st = fs.statSync(path.join(dir, f)); if (now - st.mtimeMs < 3600000 && /^\d+$/.test(f)) out.add(+f) } } catch { /* none */ }
  return out
}

function killTree(pids) {
  const done = []
  for (const pid of pids) { try { process.kill(pid); done.push(pid) } catch { /* gone or denied */ } }
  return done
}

function ramCleanStamp() { return path.join(process.env.JSTACK_RAM_CLEAN_STATE_DIR || path.join(os.homedir(), '.jstack'), '.ram-clean-stamp') }

function dockerObserve(project, busyRe, procs) {
  const ps = spawnSync('docker', ['ps', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.ID}}\t{{.Ports}}'], { encoding: 'utf8', timeout: 20000, windowsHide: true })
  if (ps.status !== 0) return { running: false, error: (ps.stderr || '').trim().slice(0, 200) }
  const rows = ps.stdout.split('\n').filter(Boolean).map(l => l.split('\t'))
  if (!rows.length) return { running: false }
  const st = spawnSync('docker', ['stats', '--no-stream', '--format', '{{.CPUPerc}}', ...rows.map(r => r[0])], { encoding: 'utf8', timeout: 30000, windowsHide: true })
  const cpu = (st.stdout || '').split('\n').filter(Boolean).map(v => parseFloat(v) || 0)
  const ports = [...new Set(rows.flatMap(r => [...r[1].matchAll(/:(\d+)->/g)].map(m => +m[1])))]
  const ns = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', timeout: 20000, windowsHide: true })
  const clients = (ns.stdout || '').split('\n').filter(l => /ESTABLISHED/.test(l) && ports.some(pt => new RegExp(`:${pt}\\s`).test(l.split(/\s+/).filter(Boolean)[2] + ' '))).length
  const busyProc = busyRe ? procs.some(p => busyRe.test(p.cmd ?? '')) : false
  return { running: true, containers: rows.length, cpuMax: Math.max(0, ...cpu), clients, busyProc, ports }
}

// One warden pass. Never throws; returns what it did. io is injectable for tests.
function runWarden({ now, procs, parent, record, cfg, state, dir, io = {} }) {
  const w = wardenConfig(cfg)
  const did = []
  if (w.mode === 'off') return did
  const act = w.mode === 'act'
  const actionsFile = path.join(dir, 'actions.jsonl')
  const log = rec => { const r = { at: new Date(now).toISOString(), mode: w.mode, ...rec }; (io.append ?? appendJsonl)(actionsFile, r); did.push(r); return r }
  const trigger = (t) => { if (shouldTrigger(state, t.type, t.key, now, w.triggerCooldownMin)) (io.append ?? appendJsonl)(path.join(dir, 'triggers.jsonl'), { at: new Date(now).toISOString(), ...t }) }
  const step = (name, fn) => { try { fn() } catch (e) { log({ action: 'error', step: name, why: String(e?.message ?? e).slice(0, 300) }) } }
  state.activity = state.activity ?? new Map()
  state.startedAt = state.startedAt ?? now

  // effects of last tick's actions: what available RAM looked like one tick later
  step('effects', () => {
    for (const e of state.pendingEffects ?? []) log({ action: 'effect', ref: e.id, of: e.of, after: { availMb: record.m.availMb }, delta: { availMb: record.m.availMb - e.availMb } })
    state.pendingEffects = []
  })
  step('activity', () => trackActivity(procs, state.activity, now, w.idleCpuPct))

  step('kills', () => {
    const kills = decideKills(procs, parent, { now, cfg: w, locks: record.lock ?? [], keepPids: (io.keepMarkers ?? keepMarkers)(now), activity: state.activity })
    for (const k of kills) {
      const killed = act ? (io.kill ?? killTree)(k.tree) : []
      const r = log({ action: 'kill', id: `k${now}-${k.pid}`, target: { pid: k.pid, name: k.name, kind: k.kind, wt: k.wt, ageMin: k.ageMin, cmd: (k.cmd ?? '').slice(0, 200) }, tree: k.tree, killed, why: k.why, before: { availMb: record.m.availMb, treePrivMb: k.privMb, treeCpu: k.cpu } })
      if (act && killed.length) (state.pendingEffects = state.pendingEffects ?? []).push({ id: r.id, of: 'kill', availMb: record.m.availMb })
      // The same command orphaned again and again: something keeps launching it, and killing it only caps the damage.
      const ck = `${k.name}|${(k.cmd ?? '').slice(0, 120)}`
      const times = [...((state.killedCmds ?? {})[ck] ?? []), now].filter(t => now - t < 2 * 3600000)
      state.killedCmds = { ...(state.killedCmds ?? {}), [ck]: times }
      if (times.length >= 3) trigger({ type: 'respawning-orphan', key: ck, detail: `${k.name} killed ${times.length} times in 2 h, its launcher keeps starting it: ${(k.cmd ?? '').slice(0, 160)}` })
    }
  })

  step('ram', () => {
    let last = state.lastRamClean ?? 0
    try { last = Math.max(last, fs.statSync(ramCleanStamp()).mtimeMs) } catch { /* never ran */ }
    const d = decideRamClean(record.m, { now, cfg: w, lastRunAt: last })
    if (!d) return
    state.lastRamClean = now
    trigger({ type: 'ram-low', key: 'ram', detail: d.why })
    let ok = false
    if (act) {
      const r = (io.run ?? spawnSync)('schtasks', ['/Run', '/TN', w.ramCleanTask], { encoding: 'utf8', timeout: 20000, windowsHide: true })
      ok = r.status === 0
      if (ok) { try { fs.mkdirSync(path.dirname(ramCleanStamp()), { recursive: true }); fs.writeFileSync(ramCleanStamp(), String(now)) } catch { /* cooldown kept in memory */ } }
    }
    const rec = log({ action: 'ram-clean', id: `r${now}`, target: w.ramCleanTask, ok, why: d.why, before: { availMb: record.m.availMb, cacheMb: record.m.cacheMb } })
    if (ok) (state.pendingEffects = state.pendingEffects ?? []).push({ id: rec.id, of: 'ram-clean', availMb: record.m.availMb })
  })

  step('hung', () => {
    state.noticed = state.noticed ?? new Set()
    for (const h of decideHung(procs, state.activity, { now, cfg: w, noticed: state.noticed })) {
      state.noticed.add(h.key)
      ;(io.append ?? appendJsonl)(path.join(dir, 'notices.jsonl'), { at: new Date(now).toISOString(), type: 'hung-test', ...h, cmd: (h.cmd ?? '').slice(0, 200) })
      log({ action: 'notice', target: { pid: h.pid, name: h.name, wt: h.wt }, why: `test at ${Math.round(h.cpu)}%+ of a core for ${h.minutes} min; left running, its agent decides` })
      trigger({ type: 'hung', key: h.key, detail: `${h.name} pid ${h.pid} ${h.minutes} min at 90%+` })
    }
  })

  step('hung-tools', () => {
    for (const h of decideHungTools(procs, parent, state.activity, { now, cfg: w, keepPids: (io.keepMarkers ?? keepMarkers)(now) })) {
      const kill = io.kill ?? killTree
      const isAlive = io.alive ?? alive
      const label = h.wt ?? 'unknown worktree'
      const r = log({ action: 'kill', id: `h${now}-${h.pid}`, target: { pid: h.pid, name: h.name, wt: h.wt, cmd: (h.cmd ?? '').slice(0, 200) }, killed: act ? kill([h.pid]) : [], why: `hung ${h.name}: no CPU for ${h.idleMin} min, ${h.privMb} MB private`, before: { availMb: record.m.availMb, privMb: h.privMb } })
      let freedMb = h.privMb
      let parentKilled = false
      if (act) {
        ;(io.sleep ?? sleepMs)(w.hungToolWaitMs)
        if (isAlive(h.pid)) {
          if (h.parentBlock) { log({ action: 'skip', target: { pid: h.parent?.pid, name: h.parent?.name }, why: `hung ${h.name} pid ${h.pid} survived its kill; launcher left alone: ${h.parentBlock}` }); freedMb = 0 }
          else {
            const killed = kill([h.parent.pid])
            parentKilled = killed.length > 0
            log({ action: 'kill', id: `hp${now}-${h.parent.pid}`, target: { pid: h.parent.pid, name: h.parent.name, wt: h.wt, cmd: (h.parent.cmd ?? '').slice(0, 200) }, killed, why: `hung ${h.name} pid ${h.pid} survived its kill; its launcher holds it, so the launcher goes` })
            freedMb = parentKilled ? h.privMb + h.parent.privMb : 0
          }
        }
        if (freedMb) (state.pendingEffects = state.pendingEffects ?? []).push({ id: r.id, of: 'kill', availMb: record.m.availMb })
      }
      const gb = Math.round(freedMb / 102.4) / 10
      ;(io.append ?? appendJsonl)(path.join(dir, 'notices.jsonl'), { at: new Date(now).toISOString(), type: 'hung-tool-killed', pid: h.pid, name: h.name, wt: h.wt, parentKilled, freedGb: gb, mode: w.mode,
        detail: `${h.name} in ${label} was hung (no CPU ${h.idleMin} min, ${h.privMb} MB); ${act ? `killed${parentKilled ? ' with its launcher' : ''}, ~${gb} GB freed` : 'would be killed (dry)'}. Rerun it if still needed.` })
      log({ action: 'notice', target: { pid: h.pid, name: h.name, wt: h.wt }, why: `hung ${h.name} in ${label}: ~${gb} GB freed; its agent was told` })
    }
  })

  step('docker', () => {
    const d = w.docker
    if (!d.project || now - (state.dockerCheckAt ?? 0) < d.checkEveryMin * 60000) return
    state.dockerCheckAt = now
    const obs = (io.dockerObserve ?? dockerObserve)(d.project, d.busyPattern ? new RegExp(d.busyPattern, 'i') : null, procs)
    const dstate = state.docker = state.docker ?? { lastActiveAt: now }
    dstate.running = obs.running
    if (!obs.running) { dstate.lastActiveAt = now; return }
    if (obs.cpuMax >= d.cpuPct || obs.clients > 0 || obs.busyProc) dstate.lastActiveAt = now
    const stop = decideDockerStop(dstate, { now, cfg: w, startedAt: state.startedAt })
    if (!stop) return
    let ok = false
    if (act) ok = (io.run ?? spawnSync)('docker', ['compose', '-p', d.project, 'stop'], { encoding: 'utf8', timeout: 180000, windowsHide: true }).status === 0
    dstate.lastActiveAt = now
    const rec = log({ action: 'docker-stop', id: `d${now}`, target: d.project, ok, why: stop.why, before: { availMb: record.m.availMb, containers: obs.containers }, undo: `docker compose -p ${d.project} start` })
    if (ok) (state.pendingEffects = state.pendingEffects ?? []).push({ id: rec.id, of: 'docker-stop', availMb: record.m.availMb })
  })

  step('triggers', () => {
    for (const t of topTriggers(record, state, now)) trigger(t)
    state.machineWindow = [...(state.machineWindow ?? []), record.m.cpu].slice(-15)
    const f = floorTrigger(state, io.floor ?? readFloor(dir))
    if (f) trigger(f)
    state.knownNames = state.knownNames ?? null
    const names = new Map(record.g.map(r => [r[0], r]))
    if (!state.knownNames) state.knownNames = new Set(names.keys())
    for (const [n, r] of names) if (!state.knownNames.has(n)) {
      state.knownNames.add(n)
      if (r[3] >= 50 || r[4] >= 1024) trigger({ type: 'new-heavy-process', key: n, detail: `${n} appeared at ${r[3]}% of a core, ${r[4]} MB` })
    }
  })
  return did
}

function readFloor(dir) { try { return JSON.parse(fs.readFileSync(path.join(dir, 'floor.json'), 'utf8')) } catch { return null } }

export { decideKills, trackActivity, decideHung, decideHungTools, isHeavyTool, decideRamClean, decideDockerStop, shouldTrigger, topTriggers, runWarden, wardenConfig, isTest, PROTECT_RE, DEFAULTS }
