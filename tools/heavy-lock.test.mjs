// node --test tools/heavy-lock.test.mjs
// Admission in heavy-lock.sh, driven through bash with a stubbed RAM reading (JSTACK_FREE_GB_CMD) and a private lock dir.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync, execFileSync } from 'node:child_process'

const WIN = process.platform === 'win32'
const HERE = import.meta.dirname
// Git's usr/bin/bash.exe, not the bin/bash.exe launcher: a timeout kills the launcher only, and the real shell would
// keep waiting in admission and take lanes from the next test.
const GIT_BASH = 'C:/Program Files/Git/usr/bin/bash.exe'
const BASH = WIN && fs.existsSync(GIT_BASH) ? GIT_BASH : 'bash'
const fwd = p => p.replace(/\\/g, '/')

let tmp, lock, freeFile, peaks, other, oldDir
let n = 0

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jstack-heavy-lock-test-'))
  freeFile = path.join(tmp, 'free')
  peaks = path.join(tmp, 'peaks.tsv')
  other = path.join(tmp, 'other-worktree')
  fs.mkdirSync(other)
  // The lock script as it was before admission (06c29cc), for the replay below.
  oldDir = path.join(tmp, 'old')
  fs.mkdirSync(oldDir)
  for (const f of ['heavy-lock.sh', 'jstack-env.sh', 'run-capped.ps1']) {
    const src = execFileSync('git', ['show', `06c29cc:tools/${f}`], { cwd: HERE, encoding: 'utf8' })
    fs.writeFileSync(path.join(oldDir, f), src)
  }
})

after(() => { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) } catch {} })

function fresh() {
  lock = path.join(tmp, `lock-${++n}`)
  fs.rmSync(peaks, { force: true })
  return lock
}

function env(extra = {}) {
  return {
    ...process.env,
    JSTACK_CONFIG: fwd(path.join(tmp, 'no-config.sh')),
    JSTACK_LOCK_DIR: fwd(lock),
    JSTACK_FREE_GB_CMD: `cat '${fwd(freeFile)}'`,
    JSTACK_RAM_CLEAN_TASK: '',
    JSTACK_JOB_PEAKS: fwd(peaks),
    JSTACK_ADMIT_POLL_S: '1',
    JSTACK_ADMIT_SAY_S: '0',
    JSTACK_TC_SLOTS: '2',
    JSTACK_HEAVY_MIN_AVAIL_GB: '12',
    JSTACK_TC_MIN_AVAIL_GB: '10',
    JSTACK_CAP_GB: '12',
    JSTACK_TC_CAP_GB: '8',
    JSTACK_ADMIT_MAX_GB: '16',
    MEM_GUARD: '1',
    ...extra,
  }
}

const setFree = gb => fs.writeFileSync(freeFile, String(gb))
const src = dir => `source '${fwd(path.join(dir ?? HERE, 'heavy-lock.sh'))}'`

// A slot someone else holds: owner line names another directory.
function hold(slot, { need, admitted = true, cwd = other, name = 'build' } = {}) {
  fs.mkdirSync(slot, { recursive: true })
  fs.writeFileSync(path.join(slot, 'owner'), `${name} Sun Oct 26 01:14:00 2026 @ ${fwd(cwd)}\n`)
  if (need != null) fs.writeFileSync(path.join(slot, 'need'), `${need}\n`)
  if (admitted) fs.writeFileSync(path.join(slot, 'admitted'), '')
}

function sh(script, { timeoutMs = 20000, extra, cwd = tmp } = {}) {
  const t0 = Date.now()
  const r = spawnSync(BASH, ['-c', script], { cwd, env: env(extra), encoding: 'utf8', timeout: timeoutMs })
  return { out: r.stdout ?? '', err: r.stderr ?? '', status: r.status, timedOut: r.error?.code === 'ETIMEDOUT', ms: Date.now() - t0 }
}

// Starts <script> in the background; resolves with its output and the ms until it printed RAN (or null).
function shAsync(script, { extra, cwd = tmp } = {}) {
  const t0 = Date.now()
  const p = spawn(BASH, ['-c', script], { cwd, env: env(extra) })
  let out = '', err = '', ranAt = null
  p.stdout.on('data', d => { out += d; if (ranAt == null && out.includes('RAN')) ranAt = Date.now() - t0 })
  p.stderr.on('data', d => { err += d })
  const done = new Promise(res => p.on('close', code => res({ out, err, code, ranAt })))
  return { proc: p, done, ranAfter: () => ranAt }
}

const wait = ms => new Promise(r => setTimeout(r, ms))

test('need: default without history, measured peak + margin with it, capped, last 5 runs only', () => {
  fresh()
  const need = (key, def, extra) => sh(`${src()}; job_need_gb ${key} ${def}`, { extra }).out.trim()
  assert.equal(need('build', 12), '12')
  fs.writeFileSync(peaks, ['t\tbuild\t5.20', 't\tbuild\t9.12', 't\ttypecheck\t4.80'].join('\n') + '\n')
  assert.equal(need('build', 12), '11', '9.12 * 1.15 = 10.5 -> 11')
  assert.equal(need('typecheck', 10), '6', '4.80 * 1.15 = 5.52 -> 6')
  fs.appendFileSync(peaks, 't\tbuild\t22.62\n')
  assert.equal(need('build', 12), '16', '26 capped at JSTACK_ADMIT_MAX_GB')
  assert.equal(need('build', 12, { JSTACK_ADMIT_MAX_GB: '30' }), '27')
  fs.appendFileSync(peaks, ['t\tbuild\t3', 't\tbuild\t3', 't\tbuild\t3', 't\tbuild\t3', 't\tbuild\t3'].join('\n') + '\n')
  assert.equal(need('build', 12), '4', 'the 22.62 run is older than the last 5')
  assert.equal(sh(`${src()}; _job_key 'coordinator:wt a'`).out, 'coordinator')
})

test('tc_run waits while an admitted build reserves the RAM, and never gives up on its own', () => {
  fresh(); setFree(14)
  hold(lock, { need: 16 })
  const r = sh(`${src()}; tc_run "echo RAN"`, { timeoutMs: 4000, extra: { JSTACK_MEM_WAIT_MAX_MIN: '0' } })
  assert.ok(r.timedOut, 'still waiting after 4 s although the old give-up is set to 0 min')
  assert.ok(!r.out.includes('RAN'))
  assert.match(r.err, /tc_run waits for 10 GB: 14 GB available, 16 GB reserved by other jobs/)
  assert.match(r.err, /--force or JSTACK_ADMIT_FORCE=1/)
})

test('tc_run starts once the build releases its slot', async () => {
  fresh(); setFree(14)
  hold(lock, { need: 16 })
  const job = shAsync(`${src()}; tc_run "echo RAN"`)
  await wait(2500)
  assert.equal(job.ranAfter(), null, 'blocked while the build holds the slot')
  fs.rmSync(lock, { recursive: true, force: true })
  const r = await job.done
  assert.equal(r.code, 0, r.err)
  assert.ok(r.ranAt >= 2500, `ran after the release (${r.ranAt} ms)`)
  assert.ok(!fs.existsSync(`${lock}-tc-1`), 'lane released')
})

test('admission: enough RAM for both runs at once; --force and MEM_GUARD=0 skip the wait', () => {
  fresh(); setFree(30)
  hold(lock, { need: 16 })
  assert.match(sh(`${src()}; tc_run "echo RAN"`).out, /RAN/, '30 - 16 >= 10')
  setFree(1)
  const f = sh(`${src()}; tc_run --force "echo RAN"`, { timeoutMs: 15000 })
  assert.match(f.out, /RAN/)
  assert.doesNotMatch(f.err, /waits for/)
  fs.rmSync(lock, { recursive: true, force: true })
  assert.match(sh(`${src()}; JSTACK_ADMIT_FORCE=1 heavy_acquire other; echo RAN; heavy_release`, { cwd: other }).out, /RAN/)
  assert.match(sh(`${src()}; tc_run "echo RAN"`, { extra: { MEM_GUARD: '0' } }).out, /RAN/)
})

test('admission: a waiting build counts against tc lanes, waiting lanes never count against anyone', () => {
  fresh(); setFree(14)
  hold(lock, { need: 12, admitted: false })
  const tc = sh(`${src()}; tc_run "echo RAN"`, { timeoutMs: 3000 })
  assert.ok(tc.timedOut, 'tc yields to the waiting build: 14 - 12 < 10')
  fs.rmSync(lock, { recursive: true, force: true })
  hold(`${lock}-tc-1`, { need: 10, admitted: false, name: 'tc' })
  const heavy = sh(`${src()}; heavy_acquire build; echo RAN; heavy_release`, { timeoutMs: 15000 })
  assert.match(heavy.out, /RAN/, 'a waiting lane does not hold the build back')
  hold(`${lock}-tc-1`, { need: 10, admitted: true, name: 'tc' })
  const blocked = sh(`${src()}; heavy_acquire build; echo RAN; heavy_release`, { timeoutMs: 3000 })
  assert.ok(blocked.timedOut, 'an admitted lane does: 14 - 10 < 12')
  assert.match(blocked.err, /heavy_acquire build waits for 12 GB/)
})

test('admission: an older holder without a need file counts its cap; the own heavy slot never counts', () => {
  fresh(); setFree(18)
  hold(lock, {})
  fs.rmSync(path.join(lock, 'admitted'))
  assert.ok(sh(`${src()}; tc_run "echo RAN"`, { timeoutMs: 3000 }).timedOut, '18 - JSTACK_CAP_GB 12 < 10')
  fs.rmSync(lock, { recursive: true, force: true })
  setFree(10)
  hold(lock, { need: 16, cwd: tmp, name: 'train-typecheck' })
  assert.match(sh(`${src()}; tc_run "echo RAN"`).out, /RAN/, 'the train typechecks inside its own slot')
})

test('admission: the wait keeps the slot fresh so the stale sweep never steals it', async () => {
  fresh(); setFree(1)
  const job = shAsync(`${src()}; heavy_acquire build; echo RAN; heavy_release`)
  await wait(1200)
  const owner = path.join(lock, 'owner')
  const old = Date.now() / 1000 - 3600
  fs.utimesSync(owner, old, old)
  await wait(2000)
  assert.ok(fs.statSync(owner).mtimeMs > Date.now() - 5000, 'owner touched while waiting')
  assert.equal(fs.readFileSync(path.join(lock, 'need'), 'utf8').trim(), '12')
  assert.ok(!fs.existsSync(path.join(lock, 'admitted')))
  setFree(20)
  const r = await job.done
  assert.match(r.out, /RAN/)
  assert.ok(!fs.existsSync(lock), 'released')
})

test('admission: unreadable RAM never blocks', () => {
  fresh(); hold(lock, { need: 16 })
  const r = sh(`${src()}; tc_run "echo RAN"`, { extra: { JSTACK_FREE_GB_CMD: 'echo 0' } })
  assert.match(r.out, /RAN/)
  assert.match(r.err, /RAM unreadable/)
})

test('peaks: heavy_capped records the measured peak of the job under its slot name', { skip: !WIN && 'run-capped.ps1 is Windows only' }, () => {
  fresh(); setFree(30)
  const r = sh(`${src()}; heavy_acquire 'probe:wt-a'; heavy_capped "node -e \\"Buffer.alloc(400*2**20).fill(1)\\""; heavy_release`, { timeoutMs: 60000 })
  assert.equal(r.status, 0, r.err + r.out)
  const rows = fs.readFileSync(peaks, 'utf8').trim().split('\n').map(l => l.split('\t'))
  assert.equal(rows.length, 1)
  assert.equal(rows[0][1], 'probe')
  assert.ok(Number(rows[0][2]) >= 0.39 && Number(rows[0][2]) < 4, `peak ${rows[0][2]} GB`)
})

// Replay of 2026-10-26 01:14Z: the heavy slot held by a 22.6 GB build (skills-loop-pool), 14 GB available, and a
// second build arriving through a tc lane. The old script's waits give up (15 min, compressed here to 0) and it
// starts: measured 1.35 GB available four minutes later. The new one keeps waiting until the slot is released.
test('replay 01:14Z: the old lock starts the second job beside the held build, the new one waits', async () => {
  fresh(); setFree(14)
  fs.writeFileSync(peaks, 't\tskills-loop-pool\t22.62\n')
  hold(lock, { need: 16, name: 'skills-loop-pool' })
  fs.rmSync(path.join(lock, 'need')); fs.rmSync(path.join(lock, 'admitted'))
  const extra = { JSTACK_MEM_WAIT_MAX_MIN: '0' }
  const oldRun = sh(`${src(oldDir)}; tc_run "echo RAN"`, { extra, timeoutMs: 20000 })
  assert.match(oldRun.out, /RAN/, 'old: starts while the build holds the slot')
  fs.writeFileSync(path.join(lock, 'need'), '16\n'); fs.writeFileSync(path.join(lock, 'admitted'), '')
  const job = shAsync(`${src()}; tc_run "echo RAN"`, { extra })
  await wait(4000)
  assert.equal(job.ranAfter(), null, 'new: still waiting with the build in the slot')
  fs.rmSync(lock, { recursive: true, force: true })
  const r = await job.done
  assert.ok(r.ranAt >= 4000, 'new: starts only after the release')
  console.log(`replay: old started in ${oldRun.ms} ms beside the held build; new waited ${r.ranAt} ms, until the release`)
})

const alivePid = () => spawnSync(BASH, ['-c', 'sleep 120 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' }).stdout.trim()
const deadPid = () => spawnSync(BASH, ['-c', 'echo $BASHPID'], { encoding: 'utf8' }).stdout.trim()
const killPid = pid => spawnSync(BASH, ['-c', `kill ${pid} 2>/dev/null`])
const nowS = () => Math.floor(Date.now() / 1000)
const status = (slot, { used, idleMin = 0 }) => fs.writeFileSync(path.join(slot, 'status'), `4242 ${used} 100.0 ${nowS() - idleMin * 60} ${nowS()}`)

test('double count: a running job reserves only what it has not used yet', () => {
  fresh(); setFree(14)
  const pid = alivePid()
  try {
    hold(lock, { need: 16 })
    fs.writeFileSync(path.join(lock, 'holder'), pid)
    assert.ok(sh(`${src()}; tc_run "echo RAN"`, { timeoutMs: 3000 }).timedOut, 'no status yet: the whole 16 GB counts, 14 - 16 < 10')
    status(lock, { used: '14.00' })
    assert.match(sh(`${src()}; tc_run "echo RAN"`).out, /RAN/, '16 - 14 used = 2 left, 14 - 2 >= 10')
    fs.rmSync(peaks, { force: true }) // the echo above recorded a tiny typecheck peak
    status(lock, { used: '3.50' })
    const r = sh(`${src()}; tc_run "echo RAN"`, { timeoutMs: 3000 })
    assert.ok(r.timedOut, '16 - 3 = 13 left, 14 - 13 < 10')
    assert.match(r.err, /13 GB reserved by other jobs/)
    fs.utimesSync(path.join(lock, 'status'), nowS() - 120, nowS() - 120)
    assert.ok(sh(`${src()}; tc_run "echo RAN"`, { timeoutMs: 3000 }).timedOut, 'a status older than JSTACK_STATUS_FRESH_S is ignored')
  } finally { killPid(pid) }
})

test('stale slots: a lane whose process tree is gone is reclaimed; a dead heavy holder reserves nothing', () => {
  fresh(); setFree(12)
  hold(`${lock}-tc-1`, { need: 10, name: 'tc' })
  fs.writeFileSync(path.join(`${lock}-tc-1`, 'holder'), deadPid())
  const r = sh(`${src()}; tc_run "echo RAN"`, { extra: { JSTACK_TC_SLOTS: '1' } })
  assert.match(r.out, /RAN/, 'the only lane was taken by a dead tc_run, and is reclaimed')
  assert.ok(!fs.existsSync(`${lock}-tc-1`))
  setFree(14)
  hold(lock, { need: 16 })
  fs.writeFileSync(path.join(lock, 'holder'), deadPid())
  assert.match(sh(`${src()}; tc_run "echo RAN"`).out, /RAN/, 'dead heavy holder with no running job reserves 0')
  assert.ok(fs.existsSync(lock), 'the heavy slot itself stays: heavy_acquire and the build may be separate calls')
  const pid = alivePid()
  try {
    hold(`${lock}-tc-2`, { need: 10, name: 'tc' })
    fs.writeFileSync(path.join(`${lock}-tc-2`, 'holder'), pid)
    fs.rmSync(lock, { recursive: true, force: true })
    fs.rmSync(peaks, { force: true })
    const live = sh(`${src()}; tc_run "echo RAN"`, { timeoutMs: 3000, extra: { JSTACK_TC_SLOTS: '2' } })
    assert.ok(live.timedOut, 'a live lane still counts: 14 - 10 < 10')
    assert.ok(fs.existsSync(`${lock}-tc-2`))
  } finally { killPid(pid) }
})

test('hung: no CPU progress for JSTACK_HUNG_MIN drops the reservation and flags the warden once', () => {
  fresh(); setFree(14)
  const perf = path.join(tmp, `perf-${n}`)
  const pid = alivePid()
  try {
    hold(lock, { need: 16, name: 'skills-loop-pool' })
    fs.writeFileSync(path.join(lock, 'holder'), pid)
    status(lock, { used: '2.00', idleMin: 20 })
    const extra = { JSTACK_PERF_DIR: fwd(perf), JSTACK_HUNG_MIN: '15' }
    const r = sh(`${src()}; tc_run "echo RAN"`, { extra })
    assert.match(r.out, /RAN/)
    assert.match(r.err, /hung \(no CPU progress for 20 min\)/)
    sh(`${src()}; tc_run "echo RAN"`, { extra })
    const rows = fs.readFileSync(path.join(perf, 'notices.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    assert.equal(rows.length, 1, 'flagged once')
    assert.equal(rows[0].type, 'hung-slot')
    assert.equal(rows[0].pid, 4242)
    assert.equal(rows[0].minutes, 20)
    assert.equal(rows[0].wt, fwd(other))
    status(lock, { used: '2.00', idleMin: 5 })
    assert.ok(sh(`${src()}; tc_run "echo RAN"`, { timeoutMs: 3000, extra }).timedOut, '5 min idle is not hung: 16 - 2 = 14 left')
  } finally { killPid(pid) }
})

test('stale sweep: a job still reporting status is never stale, however old its owner line', () => {
  fresh(); hold(lock, { need: 16 })
  const old = nowS() - 7200
  fs.utimesSync(path.join(lock, 'owner'), old, old)
  const isStale = () => sh(`${src()}; _stale '${fwd(lock)}' && echo STALE || echo LIVE`).out.trim()
  assert.equal(isStale(), 'STALE')
  status(lock, { used: '1.00' })
  assert.equal(isStale(), 'LIVE')
})

test('status: run-capped reports the running job\'s used memory into its lane, removed when it ends', { skip: !WIN && 'run-capped.ps1 is Windows only' }, async () => {
  fresh(); setFree(30)
  const job = shAsync(`${src()}; tc_run "node -e \\"const b=Buffer.alloc(300*2**20).fill(1);const t=Date.now();while(Date.now()-t<4000);\\""`, { extra: { JSTACK_STATUS_EVERY_S: '1' } })
  const st = path.join(`${lock}-tc-1`, 'status')
  let seen = null
  for (let i = 0; i < 40 && !seen; i++) {
    await wait(250)
    try { const f = fs.readFileSync(st, 'utf8').trim().split(' '); if (Number(f[1]) >= 0.25) seen = f } catch {}
  }
  const r = await job.done
  assert.equal(r.code, 0, r.err)
  assert.ok(seen, 'status with the 300 MB in use seen while running')
  assert.equal(seen.length, 5)
  assert.ok(Number(seen[2]) >= 0, 'cpu seconds')
  assert.ok(!fs.existsSync(`${lock}-tc-1`), 'lane and status gone after the run')
})
