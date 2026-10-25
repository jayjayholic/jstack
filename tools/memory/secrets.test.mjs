// node --test tools/memory/secrets.test.mjs
// Canary secrets are assembled at runtime so this file itself never holds a real-looking key.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { scan, redact, scanFields } from './secrets.mjs'

const rnd = (n, set = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789') => [...crypto.randomBytes(n)].map(b => set[b % set.length]).join('')
const NL = String.fromCharCode(10)

// Each canary: the text as it would appear, and the secret part that must never survive redaction.
const c = (prefix, secret, suffix = '') => ({ text: prefix + secret + suffix, secret })
const CANARIES = {
  'private-key': c('-----BEGIN ' + 'RSA PRIVATE KEY-----' + NL, rnd(40), NL + '-----END RSA ' + 'PRIVATE KEY-----'),
  'aws-access-key': c('', 'AK' + 'IA' + rnd(16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567')),
  'github-token': c('', 'gh' + 'p_' + rnd(36)),
  'anthropic-key': c('', 'sk-' + 'ant-' + 'api03-' + rnd(40)),
  'openai-key': c('', 'sk-' + 'proj-' + rnd(40)),
  'slack-token': c('', 'xo' + 'xb-' + rnd(12, '0123456789') + '-' + rnd(20)),
  'google-api-key': c('', 'AI' + 'za' + rnd(35)),
  'stripe-key': c('', 'sk' + '_live_' + rnd(24)),
  jwt: c('', 'ey' + 'J' + rnd(20) + '.ey' + 'J' + rnd(20) + '.' + rnd(20)),
  'connection-string-password': c('postgres://app:', rnd(14), '@db.internal:5432/app'),
  'authorization-header': c('Authorization: Bearer ', rnd(32)),
  'env-assignment': c(NL + 'export STRIPE_SECRET_TOKEN=', rnd(20), NL),
  'high-entropy': c('apiKey: "', rnd(40), '"'),
}

test('each detector class is found, and the hit never carries the value', () => {
  for (const [detector, { text }] of Object.entries(CANARIES)) {
    const hits = scan(`some text ${text} more text`)
    assert.ok(hits.length >= 1, `${detector} not detected`)
    for (const h of hits) assert.deepEqual(Object.keys(h).sort(), ['detector', 'index', 'length'])
  }
})

test('redact replaces every canary and counts them', () => {
  const text = Object.values(CANARIES).map(x => x.text).join(NL)
  const r = redact(text)
  assert.ok(r.count >= Object.keys(CANARIES).length - 1)
  for (const [detector, { secret }] of Object.entries(CANARIES)) assert.ok(!r.text.includes(secret), `leak from ${detector}`)
})

test('negative: clean prose, env names without values and placeholders are not secrets', () => {
  assert.deepEqual(scan('Set DATABASE_URL in the env file; the API_KEY is read at startup.'), [])
  assert.deepEqual(scan('postgres://user:${PGPASSWORD}@localhost/db and STRIPE_SECRET=<your key>'), [])
  assert.deepEqual(scan('a function named tokenizeInput and a password field label'), [])
})

test('scanFields names the field, not the value', () => {
  const hits = scanFields({ title: 'ok', anchors: [{ path: 'src/a.ts' }], body: 'leaked ' + CANARIES['github-token'].text })
  assert.deepEqual(hits, [{ field: 'body', detector: 'github-token' }])
})
