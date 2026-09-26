/**
 * Local end-to-end exercise of the Background Swapper host half, without the
 * Harness: stub the Cordis context, mount the registered route on a bare
 * node:http server, and drive the whole route surface over real HTTP.
 * Temporary verification harness; not shipped.
 */
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { apply, resolveConfig } from '../index.js'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

const dir = await mkdtemp(join(tmpdir(), 'bgs-'))
const warnings = []
let route
const ctx = {
  logger: { warn: (...args) => { warnings.push(args.join(' ')) }, info: () => {} },
  effect: fn => fn(),
  webServer: { register: registered => { route = registered; return () => {} } },
}

await apply(ctx, { dataDir: dir, maxImageBytes: 65536 })
assert.equal(route.path, '/__background-swapper')
assert.equal(route.kind, 'prefix')

const server = createServer((req, res) => { void route.handler(req, res) })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/__background-swapper`

const call = (path, options) => fetch(`${base}${path}`, options)

// ── empty library ───────────────────────────────────────────────────────────
let response = await call('/list')
assert.equal(response.status, 200)
let body = await response.json()
assert.deepEqual(body.items, [])
assert.deepEqual([body.activeId, body.tint, body.opacity, body.blur], [null, 0, 1, 0])
assert.deepEqual(body.limits, { pageSize: 6, maxImageBytes: 65536, maxDimension: 2560, maxNameLength: 80 })

// ── upload ──────────────────────────────────────────────────────────────────
response = await call('/images', {
  method: 'POST',
  headers: { 'content-type': 'image/png', 'x-background-name': encodeURIComponent('My Photo 🎨') },
  body: PNG,
})
assert.equal(response.status, 201)
const created = await response.json()
assert.equal(created.item.name, 'My Photo 🎨')
assert.equal(created.item.mime, 'image/png')
assert.equal(created.item.bytes, PNG.length)
assert.equal(created.activeId, created.item.id)
const id = created.item.id

// ── bytes back ──────────────────────────────────────────────────────────────
response = await call(`/images/${id}`)
assert.equal(response.status, 200)
assert.equal(response.headers.get('content-type'), 'image/png')
assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable')
assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG)

const head = await call(`/images/${id}`, { method: 'HEAD' })
assert.equal(head.status, 200)
assert.equal(await head.text(), '')

// ── rename ──────────────────────────────────────────────────────────────────
response = await call(`/images/${id}`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: '  Renamed  ' }),
})
assert.equal(response.status, 200)
assert.equal((await response.json()).item.name, 'Renamed')

response = await call(`/images/${id}`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: '   ' }),
})
assert.equal(response.status, 400)

// ── settings ────────────────────────────────────────────────────────────────
response = await call('/state', {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ tint: -0.4, opacity: 0.6, blur: 8 }),
})
assert.equal(response.status, 200)
body = await response.json()
assert.deepEqual([body.tint, body.opacity, body.blur], [-0.4, 0.6, 8])

for (const bad of [{ tint: 4 }, { opacity: -1 }, { blur: 'x' }, { activeId: 'nope' }]) {
  const refused = await call('/state', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(bad),
  })
  assert.equal(refused.status, 400, `expected 400 for ${JSON.stringify(bad)}`)
}

response = await call('/state', {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ activeId: null }),
})
assert.equal(response.status, 200)
assert.equal((await response.json()).activeId, null)

// ── refusals ────────────────────────────────────────────────────────────────
response = await call('/images', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' })
assert.equal(response.status, 415)

response = await call('/images', {
  method: 'POST',
  headers: { 'content-type': 'image/png', 'content-length': '200000' },
  body: Buffer.alloc(200000),
})
assert.equal(response.status, 413)

response = await call('/images', { method: 'POST', headers: { 'content-type': 'image/png' }, body: new Uint8Array() })
assert.equal(response.status, 400)

assert.equal((await call('/images/does-not-exist')).status, 404)
assert.equal((await call('/images/a/b')).status, 404)
assert.equal((await call('/nope')).status, 404)
assert.equal((await call('/list', { method: 'POST' })).status, 405)
assert.equal((await call('/images', { method: 'GET' })).status, 405)

// ── persistence across a restart ────────────────────────────────────────────
await apply({ ...ctx, webServer: { register: registered => { route = registered; return () => {} } } }, { dataDir: dir })
response = await call('/list')
body = await response.json()
assert.equal(body.items.length, 1)
assert.equal(body.items[0].name, 'Renamed')
assert.deepEqual([body.tint, body.opacity, body.blur], [-0.4, 0.6, 8])

// ── delete one, then clear the rest ─────────────────────────────────────────
response = await call(`/images/${id}`, { method: 'DELETE' })
assert.equal(response.status, 200)
assert.equal((await response.json()).activeId, null)
assert.equal((await call(`/images/${id}`)).status, 404)

for (const name of ['one', 'two']) {
  const uploaded = await call('/images', {
    method: 'POST',
    headers: { 'content-type': 'image/jpeg', 'x-background-name': name },
    body: PNG,
  })
  assert.equal(uploaded.status, 201)
}
assert.equal((await (await call('/list')).json()).items.length, 2)
response = await call('/images', { method: 'DELETE' })
assert.equal(response.status, 200)
assert.equal((await response.json()).removed, 2)
assert.deepEqual((await (await call('/list')).json()).items, [])

// ── config validation ───────────────────────────────────────────────────────
assert.deepEqual(resolveConfig(undefined), { pageSize: 6, maxImageBytes: 16777216, maxDimension: 2560, dataDir: '' })
assert.throws(() => resolveConfig({ pageSize: 0 }), /config\.pageSize/)
assert.throws(() => resolveConfig({ pageSize: 1.5 }), /config\.pageSize/)
assert.throws(() => resolveConfig({ dataDir: 7 }), /config\.dataDir/)
assert.throws(() => resolveConfig('nope'), /config must be a mapping/)

// ── on-disk layout ──────────────────────────────────────────────────────────
const indexFile = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'))
assert.equal(indexFile.version, 1)
assert.deepEqual(indexFile.items, [])

await new Promise(resolve => server.close(resolve))
await rm(dir, { recursive: true, force: true })
assert.deepEqual(warnings, [])
console.log('host half: all assertions passed')
