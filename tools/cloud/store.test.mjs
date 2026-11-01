// node --test tools/cloud/store.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { StoreRefused, codeOf, nameOf, open, openStore, seal, signS3 } from './store.mjs'

const KEY = Buffer.alloc(32, 7)

test('seals and opens, and refuses a tampered object', () => {
  const sealed = seal(KEY, Buffer.from('status'))
  assert.equal(open(KEY, sealed).toString(), 'status')
  sealed[sealed.length - 1] ^= 1
  assert.throws(() => open(KEY, sealed))
  assert.throws(() => open(KEY, Buffer.from('plain text here, not sealed at all')))
})

test('keeps env files and the login env out of the expiring prefix', () => {
  assert.match(nameOf(KEY, 'me/env/acme/app/.env'), /^keep\/[0-9a-f]{40}$/)
  assert.match(nameOf(KEY, 'me/login/stage.env'), /^keep\//)
  assert.match(nameOf(KEY, 'me/feat/x/status.json'), /^jstack\//)
})

test('reads the refusal code from Blob JSON and from S3 XML', () => {
  assert.equal(codeOf('{"error":{"code":"store_suspended"}}'), 'store_suspended')
  assert.equal(codeOf('<Error><Code>AccessDenied</Code></Error>'), 'AccessDenied')
  assert.equal(codeOf('gateway timeout'), 'unknown')
})

test('signs with SigV4: scope, signed headers and payload hash', () => {
  const headers = signS3(
    { region: 'us-east-1', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
    'PUT',
    new URL('https://b.s3.us-east-1.amazonaws.com/jstack/abc'),
    Buffer.from('x'),
    new Date('2026-11-01T00:00:00Z'),
  )
  assert.equal(headers['x-amz-date'], '20261101T000000Z')
  assert.match(headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261101\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/)
  assert.equal(headers['x-amz-content-sha256'], '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881')
})

async function fakeS3(answer) {
  const objects = new Map()
  const seen = []
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? '' })
    if (answer) return void res.writeHead(answer.status).end(answer.body)
    const chunks = []
    req.on('data', (c) => chunks.push(c)).on('end', () => {
      if (req.method === 'PUT') { objects.set(req.url, Buffer.concat(chunks)); return void res.writeHead(200).end() }
      const body = objects.get(req.url)
      if (!body) return void res.writeHead(404).end('<Error><Code>NoSuchKey</Code></Error>')
      res.writeHead(200).end(body)
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, seen, endpoint: `http://127.0.0.1:${server.address().port}` }
}

const s3Env = (endpoint) => ({
  JSTACK_STORE_ENV_FILE: '/nonexistent',
  JSTACK_STORE_URL: 's3://agent-state/team',
  JSTACK_STORE_ENDPOINT: endpoint,
  JSTACK_STORE_REGION: 'us-east-1',
  JSTACK_STORE_ACCESS_KEY_ID: 'AKIDEXAMPLE',
  JSTACK_STORE_SECRET_ACCESS_KEY: 'secret',
  JSTACK_STATE_KEY: KEY.toString('base64'),
})

test('round-trips sealed objects through an S3 endpoint under the prefix, signed', async () => {
  const { server, seen, endpoint } = await fakeS3()
  try {
    const store = openStore(s3Env(endpoint))
    await store.put(store.path('feat/x', 'status.json'), '{"state":"ready"}')
    assert.equal((await store.get(store.path('feat/x', 'status.json'))).toString(), '{"state":"ready"}')
    assert.equal(await store.get(store.path('feat/x', 'missing.json')), null)
    assert.match(seen[0].url, /^\/agent-state\/team\/jstack\/[0-9a-f]{40}$/)
    assert.match(seen[0].auth, /^AWS4-HMAC-SHA256 /)
  } finally {
    server.close()
  }
})

test('throws a StoreRefused on a 403 instead of an empty answer', async () => {
  const { server, endpoint } = await fakeS3({ status: 403, body: '<Error><Code>AccessDenied</Code></Error>' })
  try {
    const store = openStore(s3Env(endpoint))
    await assert.rejects(store.get('me/x'), (e) => e instanceof StoreRefused && e.code === 'AccessDenied' && e.status === 403)
    await assert.rejects(store.put('me/x', 'y'), StoreRefused)
  } finally {
    server.close()
  }
})

test('refuses an s3 store without credentials and an unknown scheme', () => {
  const env = s3Env('http://127.0.0.1:1')
  delete env.JSTACK_STORE_SECRET_ACCESS_KEY
  assert.throws(() => openStore(env), /JSTACK_STORE_SECRET_ACCESS_KEY/)
  assert.throws(() => openStore({ ...s3Env('x'), JSTACK_STORE_URL: 'ftp://x' }), /must be vercel-blob/)
})
