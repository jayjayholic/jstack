#!/usr/bin/env node
// TCP through the cloud VM's HTTPS proxy. A Claude Code cloud VM has no direct outbound TCP: only its proxy
// ($HTTPS_PROXY), which accepts CONNECT to any host and port. So a database, SSH or any TCP service outside the VM is
// reached by listening on a loopback address, mapping the service's hostname to it in /etc/hosts, and piping each
// connection through a CONNECT tunnel. Clients keep their URLs unchanged, TLS hostname checks included.
//
//   node tunnel.mjs start <host:port> [...]   map and serve each target (detached), idempotent
//   node tunnel.mjs serve <host:port> [...]   the server itself (foreground)
//   node tunnel.mjs status                    the mapped targets and whether each answers
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import net from 'node:net'

const HOSTS = process.env.JSTACK_TUNNEL_HOSTS_FILE || '/etc/hosts'
const MARK = '# jstack-tunnel'
const BASE = '127.0.1.'

function parseTarget(text) {
  const m = /^([A-Za-z0-9.-]+):(\d{1,5})$/.exec(String(text).trim())
  if (!m) throw new Error(`not host:port: ${text}`)
  return { host: m[1], port: Number(m[2]) }
}

function proxyOf(env = process.env) {
  const raw = env.HTTPS_PROXY || env.https_proxy || ''
  if (!raw) return null
  const u = new URL(raw)
  return { host: u.hostname, port: Number(u.port || 80), auth: u.username ? Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64') : null }
}

// One loopback address per hostname, kept stable across restarts by reading the existing mapping first.
function mapHosts(targets, file = HOSTS) {
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const mapped = new Map()
  for (const line of text.split('\n')) {
    const [ip, host, ...mark] = line.trim().split(/\s+/)
    const m = ip?.startsWith(BASE) && host && mark.join(' ') === MARK ? [line, ip, host] : null
    if (m) mapped.set(m[2], m[1])
  }
  const added = []
  for (const { host } of targets) {
    if (mapped.has(host)) continue
    const ip = `${BASE}${mapped.size + 1}`
    mapped.set(host, ip)
    added.push(`${ip} ${host} ${MARK}`)
  }
  if (added.length) appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}${added.join('\n')}\n`)
  return mapped
}

function connectRequest(host, port, auth) {
  return `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth ? `Proxy-Authorization: Basic ${auth}\r\n` : ''}\r\n`
}

function pipeThroughProxy(client, target, proxy) {
  const upstream = net.connect(proxy.port, proxy.host)
  let head = Buffer.alloc(0)
  const onData = (chunk) => {
    head = Buffer.concat([head, chunk])
    const end = head.indexOf('\r\n\r\n')
    if (end < 0) return
    upstream.off('data', onData)
    if (!/^HTTP\/1\.[01] 200/.test(head.subarray(0, end).toString('latin1'))) {
      client.destroy()
      upstream.destroy()
      return
    }
    const rest = head.subarray(end + 4)
    if (rest.length) client.write(rest)
    client.pipe(upstream)
    upstream.pipe(client)
  }
  upstream.on('data', onData)
  upstream.on('connect', () => upstream.write(connectRequest(target.host, target.port, proxy.auth)))
  const close = () => { client.destroy(); upstream.destroy() }
  upstream.on('error', close)
  client.on('error', close)
  client.pause()
  upstream.once('data', () => client.resume())
}

function serve(targets) {
  const proxy = proxyOf()
  if (!proxy) throw new Error('no HTTPS_PROXY: this VM needs no tunnel')
  const mapped = mapHosts(targets)
  for (const target of targets) {
    const ip = mapped.get(target.host)
    net.createServer((client) => pipeThroughProxy(client, target, proxy)).on('error', (e) => {
      if (e.code !== 'EADDRINUSE') console.error(`tunnel ${target.host}:${target.port}: ${e.message}`)
    }).listen(target.port, ip, () => console.log(`tunnel ${ip}:${target.port} -> ${target.host}:${target.port} via proxy`))
  }
}

function answers(ip, port) {
  return new Promise((resolve) => {
    const s = net.connect(port, ip)
    s.setTimeout(2000)
    s.on('connect', () => { s.destroy(); resolve(true) })
    s.on('error', () => resolve(false))
    s.on('timeout', () => { s.destroy(); resolve(false) })
  })
}

async function start(targets, self) {
  const mapped = mapHosts(targets)
  const missing = []
  for (const t of targets) if (!(await answers(mapped.get(t.host), t.port))) missing.push(t)
  if (missing.length) {
    const child = spawn(process.execPath, [self, 'serve', ...missing.map((t) => `${t.host}:${t.port}`)], { detached: true, stdio: 'ignore' })
    child.unref()
    await new Promise((r) => setTimeout(r, 500))
  }
  for (const t of targets) console.log(`${t.host}:${t.port} -> ${mapped.get(t.host)} ${(await answers(mapped.get(t.host), t.port)) ? 'up' : 'DOWN'}`)
}

async function main(argv) {
  const [command, ...rest] = argv
  const targets = rest.map(parseTarget)
  if (command === 'serve') return serve(targets)
  if (command === 'start') return start(targets, process.argv[1])
  if (command === 'status') {
    const text = existsSync(HOSTS) ? readFileSync(HOSTS, 'utf8') : ''
    for (const line of text.split('\n').filter((l) => l.endsWith(MARK))) console.log(line)
    return
  }
  console.log('usage: tunnel.mjs start|serve <host:port>... | status')
}

if (process.argv[1]?.endsWith('tunnel.mjs')) {
  main(process.argv.slice(2)).catch((e) => { console.error(`tunnel: ${e.message}`); process.exit(1) })
}

export { connectRequest, mapHosts, parseTarget, pipeThroughProxy, proxyOf }
