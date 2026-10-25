#!/usr/bin/env node
// Fail-safe entry for every jstack hook (see hooks.json). jstack-guards.mjs is imported dynamically, so even a syntax
// error in it or in a module it imports is caught here: the hook exits 0 silently and the crash lands in the guard
// log as a `hook-crash` line, instead of showing up as a hook error in every session on the machine.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const mode = process.argv[2]

function crashLog(e) {
  try {
    let log
    try { log = JSON.parse(fs.readFileSync(process.env.JSTACK_GUARDS_CONFIG || path.join(os.homedir(), '.jstack', 'guards.json'), 'utf8')).log } catch {}
    const f = log || process.env.JSTACK_GUARDS_LOG || path.join(os.homedir(), '.jstack', 'guard-log.jsonl')
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.appendFileSync(f, `${JSON.stringify({ t: new Date().toISOString(), type: 'hook-crash', mode, error: String(e?.stack ?? e).slice(0, 2000) })}\n`)
  } catch {}
}

process.on('uncaughtException', e => { crashLog(e); process.exit(0) })
process.on('unhandledRejection', e => { crashLog(e); process.exit(0) })

try {
  if (mode === 'edit') {
    const chunks = []
    for await (const c of process.stdin) chunks.push(c)
    const { edit } = await import('./jstack-preflight.mjs')
    const out = edit(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    if (out) process.stdout.write(JSON.stringify(out))
  } else {
    const guards = await import('./jstack-guards.mjs')
    await guards.runHook(mode)
  }
} catch (e) {
  crashLog(e)
}
process.exit(0)
