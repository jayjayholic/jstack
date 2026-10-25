// The process table in the shape the guard hooks use ({ p, pp, n, c, t }), from perf-snap instead of PowerShell + CIM.
// Measured on Windows 11 with ~470 processes, 5 interleaved runs: 709 -> 76 ms wall, 593 -> 78 ms CPU, 107 -> 19 MB
// peak, and the same pid/ppid/name/command line for every process both saw (see the perf ledger). Returns null when
// perf-snap isn't installed, so a caller keeps its PowerShell path as the fallback.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseSnap, filetimeToMs } from './lib.mjs'

function snapExe() {
  const dir = process.env.JSTACK_PERF_DIR || path.join(os.homedir(), '.jstack', 'perf')
  return process.env.JSTACK_PERF_SNAP || path.join(dir, 'bin', 'perf-snap.exe')
}

function listProcessesFast({ exe = snapExe() } = {}) {
  if (process.platform !== 'win32' || !fs.existsSync(exe)) return null
  const r = spawnSync(exe, ['snap'], { input: '', encoding: 'utf8', maxBuffer: 64 << 20, timeout: 20000, windowsHide: true })
  if (r.status !== 0 || !r.stdout) return null
  return toRows(parseSnap(r.stdout))
}

function toRows(snap) {
  return snap.procs.map(p => {
    const d = snap.details.get(`${p.pid}:${p.create}`)
    return { p: p.pid, pp: p.ppid, n: p.name, c: d?.cmd ?? '', t: /^\d+$/.test(p.create) && p.create !== '0' ? filetimeToMs(p.create) : 0 }
  })
}

export { listProcessesFast, toRows }
