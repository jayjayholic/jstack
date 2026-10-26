// run-capped.ps1 at the cap: a job that stalls there is killed and reported; one that dies there keeps its code;
// one below the cap is never touched. Windows only (Job Objects).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const WIN = process.platform === 'win32'
const skip = !WIN && 'run-capped.ps1 is Windows only'
const PS1 = path.join(import.meta.dirname, 'run-capped.ps1')
let tmp

before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jstack-run-capped-test-')) })
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) } catch {} })

// The stalled native tsc of 2026-10-26, in small: commit 32 MB chunks until the job refuses, keep them, then sit
// idle with zero CPU. Exits <code> instead of idling when given one (a tool that dies at the cap on its own).
function fake(name, { exitAtCap = null } = {}) {
  const f = path.join(tmp, `${name}.cjs`)
  fs.writeFileSync(f, `
const keep = []
try { for (;;) keep.push(Buffer.alloc(32 * 2 ** 20, 1)) } catch {}
${exitAtCap == null ? 'setInterval(() => {}, 1e6)' : `process.exit(${exitAtCap})`}
`)
  return f
}

function run(command, { limitGB = 0.6, stallSec = 3, nearCapGB = 0.2, notice, extraEnv = {}, timeoutMs = 60000 } = {}) {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1, '-LimitGB', String(limitGB), '-StallSec', String(stallSec), '-NearCapGB', String(nearCapGB),
    '-Exe', process.execPath, '-Command', command]
  if (notice) args.push('-NoticeFile', notice)
  const t0 = Date.now()
  const r = spawnSync('powershell', args, { encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, ...extraEnv } })
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? ''), ms: Date.now() - t0, timedOut: r.error?.code === 'ETIMEDOUT' }
}

test('a job that stalls at the cap is killed: exit 137, the cap message and one cap-killed notice', { skip }, () => {
  const notice = path.join(tmp, 'perf', 'notices.jsonl')
  const r = run(`"${fake('stall')}"`, { notice })
  assert.ok(!r.timedOut, 'run-capped returned instead of freezing')
  assert.equal(r.code, 137, r.out)
  assert.match(r.out, /hit the 0\.6 GB memory cap and stalled/)
  const rows = fs.readFileSync(notice, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].type, 'cap-killed')
  assert.equal(rows[0].capGb, 0.6)
  assert.equal(rows[0].stallSec, 3)
})

test('the job\'s memory-limit message alone is enough: killed with the near-cap margin off', { skip }, () => {
  const r = run(`"${fake('stall-port')}"`, { nearCapGB: 0 })
  assert.equal(r.code, 137, r.out)
})

test('a job that dies at the cap on its own keeps its exit code and is not reported as killed', { skip }, () => {
  const notice = path.join(tmp, 'perf-own', 'notices.jsonl')
  const r = run(`"${fake('dies', { exitAtCap: 3 })}"`, { notice })
  assert.equal(r.code, 3, r.out)
  assert.match(r.out, /hit the 0\.6 GB memory cap; the job exited 3/)
  assert.ok(!fs.existsSync(notice), 'no cap-killed notice')
})

test('a job idle below the cap is never killed, however long it idles', { skip }, () => {
  const f = path.join(tmp, 'idle.cjs')
  fs.writeFileSync(f, 'const b = Buffer.alloc(50 * 2 ** 20, 1); setTimeout(() => process.exit(0), 6000)')
  const r = run(`"${f}"`, { stallSec: 2 })
  assert.equal(r.code, 0, r.out)
  assert.doesNotMatch(r.out, /hit the/)
  assert.ok(r.ms >= 5500, `ran to its end (${r.ms} ms)`)
})

test('GOMEMLIMIT: set under the cap when unset, the caller\'s value kept', { skip }, () => {
  const f = path.join(tmp, 'env.cjs')
  fs.writeFileSync(f, 'console.log("GOMEMLIMIT=" + process.env.GOMEMLIMIT)')
  const env = { ...process.env }
  delete env.GOMEMLIMIT
  const set = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1, '-LimitGB', '8', '-Exe', process.execPath, '-Command', `"${f}"`], { encoding: 'utf8', env })
  assert.match(set.stdout, /GOMEMLIMIT=7373MiB/)
  const kept = run(`"${f}"`, { limitGB: 8, extraEnv: { GOMEMLIMIT: 'off' } })
  assert.match(kept.out, /GOMEMLIMIT=off/)
})
