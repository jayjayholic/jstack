// node --test tools/cloud/tunnel.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'

import { connectRequest, mapHosts, parseTarget, pipeThroughProxy, probe, proxyOf } from './tunnel.mjs'

test('parses host:port and refuses anything else', () => {
  assert.deepEqual(parseTarget('db.example.com:5432'), { host: 'db.example.com', port: 5432 })
  assert.throws(() => parseTarget('db.example.com'))
  assert.throws(() => parseTarget('db example:5432'))
})

test('maps each host once to a stable loopback address', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-')), 'hosts')
  fs.writeFileSync(file, '127.0.0.1 localhost\n')
  const first = mapHosts([parseTarget('a.example:5432'), parseTarget('b.example:6543')], file)
  const again = mapHosts([parseTarget('b.example:6543')], file)
  assert.equal(first.get('a.example'), '127.0.1.1')
  assert.equal(again.get('b.example'), first.get('b.example'))
  assert.equal(fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.includes('b.example')).length, 1)
})

test('reads the proxy, with and without credentials, and none when unset', () => {
  assert.deepEqual(proxyOf({ HTTPS_PROXY: 'http://127.0.0.1:36107' }), { host: '127.0.0.1', port: 36107, auth: null })
  assert.equal(proxyOf({ https_proxy: 'http://u:p@h:8080' }).auth, Buffer.from('u:p').toString('base64'))
  assert.equal(proxyOf({}), null)
  assert.match(connectRequest('db', 5432, null), /^CONNECT db:5432 HTTP\/1\.1\r\nHost: db:5432\r\n\r\n$/)
})

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

async function roundTrip(proxyAnswer) {
  const echo = net.createServer((s) => s.pipe(s))
  const echoPort = await listen(echo)
  const proxy = net.createServer((s) => {
    s.once('data', (d) => {
      assert.match(d.toString(), /^CONNECT target:\d+ /)
      if (!proxyAnswer.startsWith('HTTP/1.1 200')) return void s.end(`${proxyAnswer}\r\n\r\n`)
      const up = net.connect(echoPort, '127.0.0.1', () => {
        s.write(`${proxyAnswer}\r\n\r\n`)
        s.pipe(up)
        up.pipe(s)
      })
    })
  })
  const proxyPort = await listen(proxy)
  const front = net.createServer((c) => pipeThroughProxy(c, { host: 'target', port: echoPort }, { host: '127.0.0.1', port: proxyPort, auth: null }))
  const frontPort = await listen(front)
  const got = await new Promise((resolve) => {
    const c = net.connect(frontPort, '127.0.0.1', () => c.write('SSLRequest-bytes'))
    let data = ''
    c.on('data', (d) => { data += d; if (data.length >= 16) { c.end(); resolve(data) } })
    c.on('close', () => resolve(data))
  })
  for (const s of [echo, proxy, front]) s.close()
  return got
}

test('pipes bytes sent before the tunnel is up through it', async () => {
  assert.equal(await roundTrip('HTTP/1.1 200 Connection Established'), 'SSLRequest-bytes')
})

test('closes the client when the proxy refuses the CONNECT', async () => {
  assert.equal(await roundTrip('HTTP/1.1 403 Forbidden'), '')
})

async function probeWith(answer) {
  const proxy = net.createServer((s) => s.once('data', () => (answer === null ? undefined : s.write(`${answer}\r\n\r\n`))))
  const port = await listen(proxy)
  const got = await probe({ host: 'db.example', port: 5432 }, { host: '127.0.0.1', port, auth: null }, 500)
  proxy.close()
  return got
}

test('the probe reports what the proxy answers, not whether the local listener accepts', async () => {
  assert.equal(await probeWith('HTTP/1.1 200 Connection Established'), '200')
  assert.equal(await probeWith('HTTP/1.1 403 Forbidden'), '403')
  assert.equal(await probeWith(null), 'timeout')
})
