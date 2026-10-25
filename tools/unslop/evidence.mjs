#!/usr/bin/env node
// Runs an evidence command and records what it proved: exit code, the assertion line, the commit, whether the tree
// was dirty, the machine state (free RAM, CPU, built or not), duration, and the redacted output. A second agent
// (the skeptic) reruns the same command with `rerun`; the ledger only accepts CONFIRMED when that rerun reproduced.
//
//   node evidence.mjs run   <run-dir> --id f-7f3a.test --kind failing-test|measurement|repro-script|static-proof|render
//                          --by prosecutor#1 [--built] [--budget <n> --value-regex "<re with one group>"] -- <command...>
//   node evidence.mjs rerun <run-dir> --id f-7f3a.test --by skeptic#2
// Output goes to <run-dir>/evidence/<id>.log and <id>.evidence.json. Secrets in output are redacted and counted.
// The command runs through the shell, exactly as an agent would type it in its own terminal.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { redact } from '../memory/secrets.mjs'

const ASSERTION = /(AssertionError[^\n]*|expected[^\n]{0,200}|Expected[^\n]{0,200}|assert[^\n]{0,200}|FAIL[^\n]{0,200}|Error: [^\n]{0,200})/

function gitInfo(cwd) {
  const sha = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd, encoding: 'utf8' })
  const st = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd, encoding: 'utf8' })
  return { sha: sha.status === 0 ? sha.stdout.trim() : null, dirty: st.status === 0 ? st.stdout.trim().length > 0 : null }
}

function envFingerprint(built) {
  const freeRamPct = Math.round((os.freemem() / os.totalmem()) * 100)
  const load = os.loadavg()[0]
  return { os: process.platform, node: process.versions.node, freeRamPct, load1: os.platform() === 'win32' ? null : Math.round(load * 100) / 100, cpus: os.cpus().length, built: Boolean(built) }
}

function execute(cmd, cwd, timeoutMs) {
  const t0 = Date.now()
  const r = spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', maxBuffer: 64 << 20, timeout: timeoutMs })
  const raw = `${r.stdout ?? ''}${r.stderr ? `\n--- stderr ---\n${r.stderr}` : ''}`
  const red = redact(raw)
  const assertion = ASSERTION.exec(red.text.replace(/\r/g, ''))?.[1]?.trim() ?? null
  return { exit: r.status ?? (r.signal ? 128 : 1), signal: r.signal ?? null, output: red.text, redactions: red.count, assertion, durationMs: Date.now() - t0 }
}

function measured(output, valueRegex) {
  if (!valueRegex) return null
  const m = new RegExp(valueRegex).exec(output)
  return m ? Number(m[1]) : null
}

function runEvidence(dir, { id, kind, by, cmd, cwd = process.cwd(), built = false, budget = null, valueRegex = null, timeoutMs = 15 * 60_000 }) {
  if (!id || !kind || !by || !cmd) throw new Error('run needs --id, --kind, --by and a command after --')
  const ev = path.join(dir, 'evidence')
  fs.mkdirSync(ev, { recursive: true })
  const x = execute(cmd, cwd, timeoutMs)
  fs.writeFileSync(path.join(ev, `${id}.log`), x.output)
  const value = measured(x.output, valueRegex)
  const side = {
    id, kind, by, cmd: redact(cmd).text, cwd: path.relative(dir, cwd).replace(/\\/g, '/') || '.',
    exit: x.exit, signal: x.signal, assertion: x.assertion, ...gitInfo(cwd), env: envFingerprint(built),
    startedAt: new Date(Date.now() - x.durationMs).toISOString(), durationMs: x.durationMs,
    output: `evidence/${id}.log`, outputRedactions: x.redactions,
    ...(budget != null ? { budget: Number(budget), value, overBudget: value == null ? null : value > Number(budget), valueRegex } : {}),
    reruns: [],
  }
  fs.writeFileSync(path.join(ev, `${id}.evidence.json`), JSON.stringify(side, null, 2) + '\n')
  return side
}

function rerunEvidence(dir, { id, by, cwd, timeoutMs = 15 * 60_000 }) {
  const file = path.join(dir, 'evidence', `${id}.evidence.json`)
  const side = JSON.parse(fs.readFileSync(file, 'utf8'))
  const where = cwd ?? path.resolve(dir, side.cwd)
  const x = execute(side.cmd, where, timeoutMs)
  const value = measured(x.output, side.valueRegex)
  const sameFailure = side.exit !== 0 && x.exit !== 0 && (!side.assertion || x.assertion === side.assertion)
  const reproduced = side.kind === 'measurement' ? value != null && side.budget != null && value > side.budget : sameFailure
  const row = { by, at: new Date().toISOString(), exit: x.exit, assertion: x.assertion, assertionMatch: x.assertion === side.assertion, value, reproduced, sha: gitInfo(where).sha }
  side.reruns.push(row)
  fs.writeFileSync(path.join(dir, 'evidence', `${id}.rerun-${side.reruns.length}.log`), x.output)
  fs.writeFileSync(file, JSON.stringify(side, null, 2) + '\n')
  return row
}

function main(argv) {
  const dd = argv.indexOf('--')
  const head = dd >= 0 ? argv.slice(0, dd) : argv
  const cmd = dd >= 0 ? argv.slice(dd + 1).join(' ') : null
  const [action, dir] = head
  const get = k => { const i = head.indexOf(k); return i >= 0 ? head[i + 1] : undefined }
  if (action === 'run') {
    const s = runEvidence(dir, { id: get('--id'), kind: get('--kind'), by: get('--by'), cmd, built: head.includes('--built'), budget: get('--budget'), valueRegex: get('--value-regex') })
    console.log(`${s.id}: exit ${s.exit}${s.assertion ? `, "${s.assertion}"` : ''}, sha ${s.sha}${s.dirty ? ' (dirty tree)' : ''}, ${s.outputRedactions} redaction(s)`)
    return 0
  }
  if (action === 'rerun') {
    const r = rerunEvidence(dir, { id: get('--id'), by: get('--by') })
    console.log(`${get('--id')}: rerun by ${r.by}: exit ${r.exit}, reproduced ${r.reproduced}`)
    return r.reproduced ? 0 : 1
  }
  console.log('usage: evidence.mjs run|rerun (see the header of this file)')
  return 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)))

export { runEvidence, rerunEvidence, envFingerprint }
