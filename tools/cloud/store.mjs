// The private store behind the cloud kit: every object AES-256-GCM sealed under an HMAC-opaque name, on Vercel Blob
// (JSTACK_STORE_URL=vercel-blob://<name> + JSTACK_STORE_TOKEN) or S3 (s3://<bucket>[/<prefix>] + JSTACK_STORE_REGION,
// JSTACK_STORE_ACCESS_KEY_ID, JSTACK_STORE_SECRET_ACCESS_KEY, optional JSTACK_STORE_ENDPOINT for S3-compatible stores).
// Session state is named jstack/<hash> and env files keep/<hash>, so a bucket may expire jstack/ (14 days) and keep the
// rest. A refusal (4xx) throws a StoreRefused, which callers raise loudly instead of swallowing.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MAGIC = Buffer.from('JST1')
const BLOB_API = 'https://blob.vercel-storage.com'
const DURABLE = /^[^/]+\/(env|login)\//

class StoreRefused extends Error {
  constructor(status, code, operation) {
    super(`store refused ${operation}: HTTP ${status} ${code}`)
    this.name = 'StoreRefused'
    this.status = status
    this.code = code
  }
}

function codeOf(body) {
  try {
    const j = JSON.parse(body)
    return j?.error?.code ?? 'unknown'
  } catch {}
  return /<Code>([^<]+)<\/Code>/.exec(body)?.[1] ?? 'unknown'
}

function readEnvText(text) {
  const values = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    const q = /^(['"])(.*)\1$/.exec(m[2].trim())
    values[m[1]] = q ? q[2] : m[2].trim()
  }
  return values
}

function storeConfig(env = process.env) {
  const path = env.JSTACK_STORE_ENV_FILE || join(homedir(), '.jstack', 'store.env')
  const file = existsSync(path) ? readEnvText(readFileSync(path, 'utf8')) : {}
  const pick = (k) => env[k] || file[k] || ''
  const keyText = pick('JSTACK_STATE_KEY')
  return {
    url: pick('JSTACK_STORE_URL'),
    token: pick('JSTACK_STORE_TOKEN'),
    region: pick('JSTACK_STORE_REGION') || 'us-east-1',
    endpoint: pick('JSTACK_STORE_ENDPOINT'),
    accessKeyId: pick('JSTACK_STORE_ACCESS_KEY_ID'),
    secretAccessKey: pick('JSTACK_STORE_SECRET_ACCESS_KEY'),
    user: pick('JSTACK_STORE_USER') || 'me',
    key: keyText ? Buffer.from(keyText, 'base64') : null,
  }
}

function blobBackend(token) {
  const storeId = /^vercel_blob_rw_([A-Za-z0-9]+)_/.exec(token)?.[1]
  if (!storeId) throw new Error('JSTACK_STORE_TOKEN is not a Vercel Blob read-write token')
  const auth = { authorization: `Bearer ${token}`, 'x-api-version': '11' }
  const base = `https://${storeId.toLowerCase()}.public.blob.vercel-storage.com`
  return {
    async put(name, data) {
      const r = await fetch(`${BLOB_API}/?pathname=${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { ...auth, 'x-content-type': 'application/octet-stream', 'x-add-random-suffix': '0', 'x-allow-overwrite': '1', 'x-cache-control-max-age': '60' },
        body: new Uint8Array(data),
      })
      if (!r.ok) throw new StoreRefused(r.status, codeOf(await r.text()), 'put')
    },
    async get(name) {
      const r = await fetch(`${base}/${name}?fresh=${Date.now()}-${Math.random().toString(36).slice(2)}`, { cache: 'no-store' })
      if (r.status === 404) return null
      if (!r.ok) throw new StoreRefused(r.status, codeOf(await r.text()), 'get')
      return Buffer.from(await r.arrayBuffer())
    },
  }
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const hmac = (key, data) => createHmac('sha256', key).update(data).digest()

// AWS Signature Version 4 for one object request (no SDK needed: the hooks run on plain node).
function signS3(config, method, url, body, now = new Date()) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const day = amzDate.slice(0, 8)
  const payloadHash = sha256(body ?? Buffer.alloc(0))
  const headers = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate }
  const signed = Object.keys(headers).sort()
  const canonical = [
    method,
    url.pathname.split('/').map((s) => encodeURIComponent(decodeURIComponent(s))).join('/'),
    '',
    ...signed.map((h) => `${h}:${headers[h]}`),
    '',
    signed.join(';'),
    payloadHash,
  ].join('\n')
  const scope = `${day}/${config.region}/s3/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n')
  let k = hmac(`AWS4${config.secretAccessKey}`, day)
  for (const part of [config.region, 's3', 'aws4_request']) k = hmac(k, part)
  const signature = createHmac('sha256', k).update(toSign).digest('hex')
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${signature}`,
  }
}

function s3Backend(config) {
  if (!config.accessKeyId || !config.secretAccessKey) throw new Error('an s3:// store needs JSTACK_STORE_ACCESS_KEY_ID and JSTACK_STORE_SECRET_ACCESS_KEY')
  const [bucket, ...rest] = config.url.replace(/^s3:\/\//, '').split('/')
  const prefix = rest.filter(Boolean).join('/')
  const origin = config.endpoint ? config.endpoint.replace(/\/+$/, '') + `/${bucket}` : `https://${bucket}.s3.${config.region}.amazonaws.com`
  const urlOf = (name) => new URL(`${origin}/${prefix ? `${prefix}/` : ''}${name}`)
  const request = async (method, name, body) => {
    const url = urlOf(name)
    return fetch(url, { method, headers: signS3(config, method, url, body), body: body ? new Uint8Array(body) : undefined })
  }
  return {
    async put(name, data) {
      const r = await request('PUT', name, data)
      if (!r.ok) throw new StoreRefused(r.status, codeOf(await r.text()), 'put')
    },
    async get(name) {
      const r = await request('GET', name)
      if (r.status === 404) return null
      if (!r.ok) throw new StoreRefused(r.status, codeOf(await r.text()), 'get')
      return Buffer.from(await r.arrayBuffer())
    },
  }
}

function nameOf(key, path) {
  return `${DURABLE.test(path) ? 'keep' : 'jstack'}/${createHmac('sha256', key).update(path).digest('hex').slice(0, 40)}`
}

function seal(key, plain) {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([c.update(plain), c.final()])
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), body])
}

function open(key, sealed) {
  if (!sealed.subarray(0, 4).equals(MAGIC)) throw new Error('not a sealed object')
  const d = createDecipheriv('aes-256-gcm', key, sealed.subarray(4, 16))
  d.setAuthTag(sealed.subarray(16, 32))
  return Buffer.concat([d.update(sealed.subarray(32)), d.final()])
}

function openStore(env = process.env) {
  const config = storeConfig(env)
  if (!config.key || config.key.length !== 32) throw new Error('JSTACK_STATE_KEY must be 32 bytes, base64')
  const backend = config.url.startsWith('vercel-blob:')
    ? blobBackend(config.token)
    : config.url.startsWith('s3:')
      ? s3Backend(config)
      : null
  if (!backend) throw new Error('JSTACK_STORE_URL must be vercel-blob://<name> or s3://<bucket>[/<prefix>]')
  return {
    path: (...parts) => [config.user, ...parts].join('/'),
    put: (path, data) => backend.put(nameOf(config.key, path), seal(config.key, Buffer.from(data))),
    async get(path) {
      const raw = await backend.get(nameOf(config.key, path))
      return raw ? open(config.key, raw) : null
    },
  }
}

export { StoreRefused, codeOf, nameOf, open, openStore, seal, signS3, storeConfig }
