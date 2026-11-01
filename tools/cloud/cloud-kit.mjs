#!/usr/bin/env node
// Cloud session kit for any repo (Claude Code on the web): restores the files git does not carry (env files, keys)
// from a private encrypted store, saves work in progress at every turn end, and publishes a handoff the local
// orchestrator can poll. Generic: what each repo needs comes from the owner's ~/.jstack/cloud-env.json, pushed into
// the store with the files; nothing about a project is written here.
//
//   node cloud-kit.mjs env-push [--repo <dir>]     owner's machine: seal the repo's listed files into the store
//   node cloud-kit.mjs env-restore [--repo <dir>]  cloud: write them back (0600, only where git ignores them)
//   node cloud-kit.mjs autocommit [--repo <dir>]   cloud: commit + push WIP on the work branch, never secrets
//   node cloud-kit.mjs handoff --branch <b> --state running|waiting|wrapped|ready|failed [--task t] [--done x]...
//                      [--failure x]... [--next x]                       publish <user>/<branch>/status.json + handoff.md
//   node cloud-kit.mjs put <path> <file> | get <path>   one sealed object under <user>/<path>
//   node cloud-kit.mjs hook-start | hook-stop       SessionStart / Stop hooks: cloud only, and only in repos without
//                                                   their own kit (scripts/cloud/setup.sh)
//
// Store: JSTACK_STORE_URL=vercel-blob://<name>, JSTACK_STORE_TOKEN (store-scoped read-write token), JSTACK_STATE_KEY
// (32 bytes, base64; every object AES-256-GCM sealed under an HMAC-opaque name), JSTACK_STORE_USER (path prefix), from
// the environment or ~/.jstack/store.env. Same object format as the store client it was taken from, so both read it.
import { spawnSync } from 'node:child_process'
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, normalize } from 'node:path'

const MAGIC = Buffer.from('JST1')
const BLOB_API = 'https://blob.vercel-storage.com'
const PROTECTED = new Set((process.env.JSTACK_PROTECTED_BRANCHES || 'stage,production,main,master').split(','))
const WIP_MESSAGE = 'chore(wip): auto-save cloud session work'
const SECRET_PATHS = [
  /(^|\/)\.env(\.[^/]*)?$/, /(^|\/)\.envrc$/, /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/, /(^|\/)\.npmrc$/, /(^|\/)\.netrc$/, /(^|\/)\.vercel\//,
  /(^|\/)credentials(\.[^/]*)?\.json$/i, /\.tfvars$/, /(^|\/)\.agent(\/|$)/, /(^|\/)\.mcp\.json$/, /(^|\/)\.auth\//,
]
const SECRET_CONTENT = /DOTENV_PRIVATE_KEY[A-Z_]*\s*=\s*\S|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-ant-[a-zA-Z0-9-]{20,}/

const isSecretPath = (p) => SECRET_PATHS.some((re) => re.test(p.replace(/\\/g, '/')))
const isCloud = (env = process.env) => env.CLAUDE_CODE_REMOTE === 'true' || env.JSTACK_CLOUD === '1'

function git(args, cwd, input) {
  const r = spawnSync('git', args, { cwd, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: (r.stderr ?? '').trim() }
}

const readEnvFile = (file) => (existsSync(file) ? readEnvFileText(readFileSync(file, 'utf8')) : {})

function storeConfig(env = process.env) {
  const file = readEnvFile(env.JSTACK_STORE_ENV_FILE || join(homedir(), '.jstack', 'store.env'))
  const pick = (k) => env[k] || file[k] || ''
  const key = pick('JSTACK_STATE_KEY') ? Buffer.from(pick('JSTACK_STATE_KEY'), 'base64') : null
  return { url: pick('JSTACK_STORE_URL'), token: pick('JSTACK_STORE_TOKEN'), user: pick('JSTACK_STORE_USER') || 'me', key }
}

function openStore(env = process.env) {
  const { url, token, user, key } = storeConfig(env)
  if (!url.startsWith('vercel-blob:')) throw new Error('JSTACK_STORE_URL must be vercel-blob://<name> for this kit')
  if (!key || key.length !== 32) throw new Error('JSTACK_STATE_KEY must be 32 bytes, base64')
  const storeId = /^vercel_blob_rw_([A-Za-z0-9]+)_/.exec(token)?.[1]
  if (!storeId) throw new Error('JSTACK_STORE_TOKEN is not a Vercel Blob read-write token')
  const auth = { authorization: `Bearer ${token}`, 'x-api-version': '11' }
  const nameOf = (path) => `jstack/${createHmac('sha256', key).update(path).digest('hex').slice(0, 40)}`
  const seal = (plain) => {
    const iv = randomBytes(12)
    const c = createCipheriv('aes-256-gcm', key, iv)
    const body = Buffer.concat([c.update(plain), c.final()])
    return Buffer.concat([MAGIC, iv, c.getAuthTag(), body])
  }
  const open = (sealed) => {
    if (!sealed.subarray(0, 4).equals(MAGIC)) throw new Error('not a sealed object')
    const d = createDecipheriv('aes-256-gcm', key, sealed.subarray(4, 16))
    d.setAuthTag(sealed.subarray(16, 32))
    return Buffer.concat([d.update(sealed.subarray(32)), d.final()])
  }
  return {
    path: (...parts) => [user, ...parts].join('/'),
    async put(path, data) {
      const r = await fetch(`${BLOB_API}/?pathname=${encodeURIComponent(nameOf(path))}`, {
        method: 'PUT',
        headers: { ...auth, 'x-content-type': 'application/octet-stream', 'x-add-random-suffix': '0', 'x-allow-overwrite': '1', 'x-cache-control-max-age': '60' },
        body: new Uint8Array(seal(Buffer.from(data))),
      })
      if (!r.ok) throw new Error(`store put HTTP ${r.status}`)
    },
    async get(path) {
      const base = `https://${storeId.toLowerCase()}.public.blob.vercel-storage.com`
      const r = await fetch(`${base}/${nameOf(path)}?fresh=${Date.now()}-${Math.random().toString(36).slice(2)}`, { cache: 'no-store' })
      if (r.status === 404) return null
      if (!r.ok) throw new Error(`store get HTTP ${r.status}`)
      return open(Buffer.from(await r.arrayBuffer()))
    },
  }
}

function repoSlug(remote) {
  const m = /[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(String(remote).trim())
  return m ? `${m[1]}/${m[2]}` : null
}

function slugOf(dir) {
  const slug = repoSlug(git(['remote', 'get-url', 'origin'], dir).stdout)
  if (!slug) throw new Error(`no origin remote in ${dir}`)
  return slug
}

function safeTarget(dir, file) {
  const clean = normalize(file).replace(/\\/g, '/')
  if (clean.startsWith('..') || clean.startsWith('/')) return `${file} is outside the repo`
  if (!isSecretPath(clean)) return `${file} is not a path the autocommit holds back`
  if (!git(['check-ignore', '-q', clean], dir).ok) return `${file} is not ignored by git`
  return null
}

function pickKeys(text, keys) {
  const values = readEnvFileText(text)
  return keys.filter((k) => values[k] !== undefined).map((k) => `${k}=${JSON.stringify(values[k])}`).join('\n')
}

function readEnvFileText(text) {
  const values = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    const q = /^(['"])(.*)\1$/.exec(m[2].trim())
    values[m[1]] = q ? q[2] : m[2].trim()
  }
  return values
}

async function envPush(store, dir, manifestFile = join(homedir(), '.jstack', 'cloud-env.json')) {
  const slug = slugOf(dir)
  const entries = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8'))[slug] : null
  if (!entries?.length) throw new Error(`${slug} has no entry in ${manifestFile}`)
  const files = []
  const tunnels = entries.filter((entry) => entry.tunnel).map((entry) => entry.tunnel)
  for (const entry of entries.filter((e) => e.file)) {
    const refused = safeTarget(dir, entry.file)
    if (refused) throw new Error(`refusing to push: ${refused}`)
    const text = readFileSync(join(dir, entry.file), 'utf8')
    const content = entry.keys ? `${pickKeys(text, entry.keys)}\n` : text
    if (!content.trim()) throw new Error(`${entry.file} has none of the listed keys`)
    await store.put(store.path('env', slug, entry.file), content)
    files.push({ file: entry.file, keys: content.split('\n').filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l)).length })
  }
  await store.put(store.path('env', slug, 'manifest.json'), JSON.stringify({ repo: slug, files, tunnels }))
  return { repo: slug, files, tunnels }
}

async function envRestore(store, dir) {
  const slug = slugOf(dir)
  const raw = await store.get(store.path('env', slug, 'manifest.json'))
  if (!raw) return []
  const written = []
  const manifest = JSON.parse(raw.toString('utf8'))
  // The VM has no direct outbound TCP: services outside it (a database) are reached through its HTTPS proxy.
  if (manifest.tunnels?.length && (process.env.HTTPS_PROXY || process.env.https_proxy)) {
    const r = spawnSync(process.execPath, [join(import.meta.dirname, 'tunnel.mjs'), 'start', ...manifest.tunnels], { encoding: 'utf8', timeout: 30_000 })
    written.push(`tunnels: ${(r.stdout || r.stderr || '').trim().split(String.fromCharCode(10)).join('; ')}`)
  }
  for (const { file } of manifest.files) {
    const refused = safeTarget(dir, file)
    if (refused) throw new Error(`refusing to restore: ${refused}`)
    const content = await store.get(store.path('env', slug, file))
    if (!content) throw new Error(`${file} is listed but missing in the store`)
    writeFileSync(join(dir, file), content, { mode: 0o600 })
    written.push(file)
  }
  return written
}

function changedPaths(dir) {
  const r = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: dir, encoding: 'utf8' })
  if (r.status !== 0) return []
  const entries = (r.stdout ?? '').split('\0').filter(Boolean)
  const paths = []
  for (let i = 0; i < entries.length; i++) {
    paths.push(entries[i].slice(3))
    if (entries[i][0] === 'R' || entries[i][0] === 'C') paths.push(entries[++i] ?? '')
  }
  return paths.filter(Boolean)
}

function autocommit(dir, env = process.env, { push = true } = {}) {
  if (!isCloud(env)) return { action: 'skipped', reason: 'not a cloud session' }
  const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], dir).stdout.trim()
  if (!branch) return { action: 'skipped', reason: 'detached HEAD' }
  if (PROTECTED.has(branch)) return { action: 'skipped', reason: `protected branch ${branch}` }
  const gitDir = git(['rev-parse', '--absolute-git-dir'], dir).stdout.trim()
  const busy = ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'].find((m) => existsSync(join(gitDir, m)))
  if (busy) return { action: 'skipped', reason: `${busy} in progress` }
  const staged = git(['diff', '--cached', '--name-only', '-z'], dir).stdout.split('\0').filter((p) => p && isSecretPath(p))
  if (staged.length) git(['reset', '-q', '--', ...staged], dir)
  const changed = changedPaths(dir)
  const held = changed.filter(isSecretPath)
  const safe = changed.filter((p) => !isSecretPath(p))
  let committed = false
  if (safe.length) {
    const add = git(['--literal-pathspecs', 'add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], dir, `${safe.join('\0')}\0`)
    if (!add.ok) return { action: 'skipped', reason: `git add failed: ${add.stderr}` }
    if (SECRET_CONTENT.test(git(['diff', '--cached'], dir).stdout)) {
      git(['reset', '-q', '--', ...safe], dir)
      return { action: 'skipped', reason: 'staged diff looks like it holds a secret; left uncommitted' }
    }
    if (!git(['diff', '--cached', '--quiet'], dir).ok) {
      const c = git(['commit', '-q', '-m', WIP_MESSAGE], dir)
      if (!c.ok) return { action: 'skipped', reason: `git commit failed: ${c.stderr}` }
      committed = true
    }
  }
  const remote = git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], dir)
  const ahead = !remote.ok || git(['rev-list', '--count', `origin/${branch}..HEAD`], dir).stdout.trim() !== '0'
  if (!push || !ahead) return { action: committed ? 'committed' : 'nothing', branch, held }
  const p = git(['push', '-u', 'origin', `HEAD:refs/heads/${branch}`], dir)
  return p.ok ? { action: 'pushed', branch, held } : { action: committed ? 'committed' : 'nothing', branch, held, detail: `push failed: ${p.stderr}` }
}

function parseArgs(argv) {
  const flags = { done: [], failure: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const k = a.slice(2)
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true'
    if (k === 'done' || k === 'failure') flags[k].push(v)
    else flags[k] = v
  }
  return flags
}

async function handoff(store, dir, flags) {
  const branch = flags.branch || git(['symbolic-ref', '--quiet', '--short', 'HEAD'], dir).stdout.trim()
  if (!branch) throw new Error('handoff needs --branch')
  const sha = git(['rev-parse', 'HEAD'], dir).stdout.trim()
  const status = {
    state: flags.state || 'running', branch, sha, ...(flags.state === 'ready' ? { ready_sha: sha } : {}),
    next: flags.next || '', reason: flags.failure.join('; ') || undefined, updated: new Date().toISOString(),
  }
  const lines = [`# Handoff: ${branch}`, '', flags.task ? `Task: ${flags.task}\n` : '', '## Done', ...flags.done.map((d) => `- ${d}`),
    '', '## Failures', ...flags.failure.map((f) => `- ${f}`), '', `## Next\n${flags.next || '-'}`, '', `sha ${sha}, ${status.updated}`]
  await store.put(store.path(branch, 'handoff.md'), lines.join('\n'))
  await store.put(store.path(branch, 'status.json'), JSON.stringify(status, null, 2))
  return status
}

const hasOwnKit = (dir) => existsSync(join(dir, 'scripts', 'cloud', 'setup.sh'))
const repoDir = (flags) => flags.repo || process.env.CLAUDE_PROJECT_DIR || process.cwd()

async function main(argv) {
  const [command, ...rest] = argv
  const flags = parseArgs(rest)
  const dir = repoDir(flags)
  if (command === 'hook-start' || command === 'hook-stop') {
    if (!isCloud() || hasOwnKit(dir)) return 0
    try {
      if (command === 'hook-start') {
        const written = await envRestore(openStore(), dir)
        console.log(`jstack cloud: ${written.length ? `restored ${written.join(', ')}` : 'no env stored for this repo'}`)
      } else {
        const r = autocommit(dir)
        console.error(`jstack cloud autocommit: ${r.action}${r.reason ? ` (${r.reason})` : ''}${r.held?.length ? ` held back: ${r.held.join(', ')}` : ''}`)
      }
    } catch (e) {
      console.error(`jstack cloud ${command}: ${e instanceof Error ? e.message : e}`)
    }
    return 0
  }
  if (command === 'env-push') {
    const m = await envPush(openStore(), dir)
    console.log(`pushed ${m.repo}: ${m.files.map((f) => `${f.file} (${f.keys} keys)`).join(', ')}${m.tunnels.length ? `, tunnels ${m.tunnels.join(', ')}` : ''} (values not shown)`)
    return 0
  }
  if (command === 'env-restore') {
    const written = await envRestore(openStore(), dir)
    console.log(written.length ? `restored ${written.join(', ')}` : 'no env stored for this repo')
    return 0
  }
  if (command === 'autocommit') {
    console.log(JSON.stringify(autocommit(dir)))
    return 0
  }
  if (command === 'put' && rest[0] && rest[1]) {
    const store = openStore()
    await store.put(store.path(rest[0]), readFileSync(rest[1]))
    console.log(`put ${rest[0]} (encrypted)`)
    return 0
  }
  if (command === 'get' && rest[0]) {
    const store = openStore()
    const data = await store.get(store.path(rest[0]))
    if (!data) { console.error(`no object at ${rest[0]}`); return 1 }
    process.stdout.write(data)
    return 0
  }
  if (command === 'handoff') {
    const s = await handoff(openStore(), dir, flags)
    console.log(`published ${s.branch}: ${s.state} @ ${s.sha.slice(0, 9)}`)
    return 0
  }
  console.log('usage: cloud-kit.mjs env-push|env-restore|autocommit|handoff|put|get|hook-start|hook-stop [--repo <dir>]')
  return 2
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('cloud-kit.mjs')) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    console.error(`cloud-kit: ${e instanceof Error ? e.message : e}`)
    process.exit(1)
  })
}

export { autocommit, envPush, envRestore, handoff, isSecretPath, openStore, pickKeys, repoSlug, safeTarget }
