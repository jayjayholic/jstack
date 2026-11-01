#!/usr/bin/env node
// TCP through the cloud VM's HTTPS proxy. A Claude Code cloud VM has no direct outbound TCP: only its proxy
// ($HTTPS_PROXY). This listens on a loopback address, maps the service's hostname to it in /etc/hosts, and pipes each
// connection through a CONNECT tunnel, so clients keep their URLs and TLS hostname checks.
//
// UNVERIFIED: whether the proxy carries CONNECT to a non-HTTPS port. One probe got 200 for port 5432; in another
// session a database query through the same kind of VM hung for minutes. The proxy is meant for HTTPS and WebSocket
// traffic, so the safe road to a database outside the VM is its HTTPS or WebSocket API (or a WS bridge you run next
// to it). Trust this tunnel only when `start` or `status` prints `CONNECT 200` for that target.
//
//   node tunnel.mjs start <host:port> [...]   map and serve each target (detached), idempotent, then probe each
//   node tunnel.mjs serve <host:port> [...]   the server itself (foreground)
//   node tunnel.mjs status                    the mapped targets and the proxy's answer to a CONNECT for each
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

// What the proxy itself answers to a CONNECT for the target: a local listener always accepts, so only this says
// whether the target is reachable at all.
function probe(target, proxy, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const s = net.connect(proxy.port, proxy.host)
    let head = ''
    const done = (answer) => { s.destroy(); resolve(answer) }
    s.setTimeout(timeoutMs, () => done('timeout'))
    s.on('error', (e) => done(`error ${e.code || e.message}`))
    s.on('connect', () => s.write(connectRequest(target.host, target.port, proxy.auth)))
    s.on('data', (d) => {
      head += d.toString('latin1')
      const line = head.split('\r\n')[0]
      if (head.includes('\r\n')) done(/^HTTP\/1\.[01] (\d{3})/.exec(line)?.[1] ?? line.slice(0, 60))
    })
  })
}

async function report(targets, mapped, proxy) {
  for (const t of targets) {
    const answer = proxy ? await probe(t, proxy) : 'no proxy'
    console.log(`${t.host}:${t.port} -> ${mapped.get(t.host)} CONNECT ${answer}${answer === '200' ? '' : ' (not reachable through the proxy)'}`)
  }
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
  await report(targets, mapped, proxyOf())
}

async function main(argv) {
  const [command, ...rest] = argv
  const targets = rest.map(parseTarget)
  if (command === 'serve') return serve(targets)
  if (command === 'start') return start(targets, process.argv[1])
  if (command === 'status') {
    const text = existsSync(HOSTS) ? readFileSync(HOSTS, 'utf8') : ''
    const mapped = new Map(text.split('\n').filter((l) => l.endsWith(MARK)).map((l) => l.trim().split(/\s+/)).map(([ip, host]) => [host, ip]))
    const ports = targets.length ? targets : [...mapped.keys()].map((host) => ({ host, port: 443 }))
    return report(ports, mapped, proxyOf())
  }
  console.log('usage: tunnel.mjs start|serve <host:port>... | status')
}

if (process.argv[1]?.endsWith('tunnel.mjs')) {
  main(process.argv.slice(2)).catch((e) => { console.error(`tunnel: ${e.message}`); process.exit(1) })
}

export { connectRequest, mapHosts, parseTarget, pipeThroughProxy, probe, proxyOf }
