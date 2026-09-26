/**
 * Background Swapper host half.
 *
 * Owns one directory of background images and the index that describes them,
 * and exposes both to the browser half over one HTTP route table under
 * `/__background-swapper`:
 *
 * - `GET    /list`            the library, the current settings, the defaults, and the limits
 * - `POST   /images`          one uploaded image (raw body, name in a header)
 * - `DELETE /images`          remove every stored image
 * - `GET    /images/<id>`     the stored bytes, immutably cacheable
 * - `PATCH  /images/<id>`     rename
 * - `DELETE /images/<id>`     delete
 * - `PATCH  /state`           active background, tint, opacity, blur
 *
 * The module imports `node:` builtins only: it must load on a released `dsh`,
 * where no workspace resolution or build step is available for an out-of-tree
 * package. Configuration therefore arrives as the loader row's `config` object
 * and is validated here, loudly, at activation.
 *
 * @module dsh-background-swapper
 */

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  DEFAULT_SETTINGS, IMAGE_TYPES, MAX_NAME_LENGTH, createStore, normalizeBlur, normalizeName, normalizeOpacity,
  normalizeTint,
} from './store.js'

/** Stable Cordis plugin name, matching the bundle row id. */
export const name = 'background-swapper'

/** Services required before `apply` runs: the HTTP carrier the routes register on. */
export const inject = ['webServer']

/** Prefix every route of this plugin lives under. */
export const ROUTE = '/__background-swapper'

/** Library and settings read. */
export const LIST_ROUTE = `${ROUTE}/list`

/** Image collection: POST here, append `/<id>` to address one image. */
export const IMAGES_ROUTE = `${ROUTE}/images`

/** Settings write. */
export const STATE_ROUTE = `${ROUTE}/state`

/** Largest JSON request body accepted, in bytes. */
const MAX_JSON_BYTES = 16 * 1024

/** Fallback name for an upload that carries none, so a raw POST is still usable. */
const UNNAMED = 'Untitled photo'

/** Field defaults, bounds, and the message shown when a supplied value is outside them. */
const FIELDS = {
  pageSize: { fallback: 6, min: 1, max: 24, integer: true },
  maxImageBytes: { fallback: 16 * 1024 * 1024, min: 64 * 1024, max: 64 * 1024 * 1024, integer: true },
  maxDimension: { fallback: 2560, min: 256, max: 8192, integer: true },
}

/**
 * One resolved, validated configuration.
 * @typedef {object} ResolvedConfig
 * @property {number} pageSize - Backgrounds per page in the panel's history grid.
 * @property {number} maxImageBytes - Largest accepted upload.
 * @property {number} maxDimension - Longest edge the browser half downscales to before upload.
 * @property {string} dataDir - Library directory; `''` means the default under the harness home.
 */

/**
 * Validate the row's `config` and apply every default explicitly.
 * @param {unknown} raw - The loader row's config object, or undefined when the row omits it.
 * @returns {ResolvedConfig} The resolved configuration.
 * @throws {Error} When a supplied field is not a number in range, or not a string where one is required.
 */
export function resolveConfig(raw) {
  if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) {
    throw new Error('background-swapper: config must be a mapping')
  }
  const supplied = /** @type {Record<string, unknown>} */ (raw ?? {})
  /** @type {ResolvedConfig} */
  const resolved = { pageSize: 0, maxImageBytes: 0, maxDimension: 0, dataDir: '' }
  for (const [field, rule] of Object.entries(FIELDS)) {
    const value = supplied[field]
    if (value === undefined) {
      resolved[field] = rule.fallback
      continue
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < rule.min || value > rule.max
      || (rule.integer && !Number.isInteger(value))) {
      throw new Error(
        `background-swapper: config.${field} must be ${rule.integer ? 'an integer' : 'a number'} `
        + `from ${rule.min} to ${rule.max}, received ${JSON.stringify(value)}`,
      )
    }
    resolved[field] = value
  }
  const dataDir = supplied.dataDir
  if (dataDir !== undefined && typeof dataDir !== 'string') {
    throw new Error(`background-swapper: config.dataDir must be a path string, received ${JSON.stringify(dataDir)}`)
  }
  resolved.dataDir = dataDir ?? ''
  return resolved
}

/**
 * Expand a leading `~` against the current user's home directory.
 * @param {string} path - Configured path.
 * @returns {string} The path with `~` resolved, absolute.
 */
function expandHome(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return resolve(path)
}

/**
 * Default library directory: `<DSH_HOME>/storages/background-swapper`.
 * @returns {string} Absolute path.
 */
function defaultDataDir() {
  const configured = process.env.DSH_HOME
  const home = configured !== undefined && configured.trim() !== '' ? expandHome(configured.trim()) : join(homedir(), '.dsh')
  return join(home, 'storages', 'background-swapper')
}

/**
 * Write one JSON response with caching disabled.
 * @param {import('node:http').ServerResponse} res - Response to own.
 * @param {number} status - HTTP status.
 * @param {unknown} body - Value to serialize.
 * @param {boolean} [head] - Whether the request was a HEAD, which sends headers only.
 */
function writeJson(res, status, body, head = false) {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': payload.length,
  })
  res.end(head ? undefined : payload)
}

/**
 * Write one plain-text response.
 * @param {import('node:http').ServerResponse} res - Response to own.
 * @param {number} status - HTTP status.
 * @param {string} message - Line to send.
 */
function writeText(res, status, message) {
  const payload = Buffer.from(`${message}\n`)
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': payload.length })
  res.end(payload)
}

/**
 * Refuse a method, naming the ones the route answers.
 * @param {import('node:http').ServerResponse} res - Response to own.
 * @param {string} allow - `Allow` header value.
 */
function methodNotAllowed(res, allow) {
  res.writeHead(405, { allow, 'content-type': 'text/plain; charset=utf-8' })
  res.end('method not allowed\n')
}

/** @param {import('node:http').ServerResponse} res - Response to own. */
function notFound(res) {
  writeText(res, 404, 'not found')
}

/**
 * Read a request body, refusing one larger than the caller accepts.
 * @param {import('node:http').IncomingMessage} req - Request being read.
 * @param {number} maxBytes - Largest accepted body.
 * @returns {Promise<Buffer>} The complete body.
 * @throws {Error} With `code` `BODY_TOO_LARGE` when the body passes `maxBytes`.
 */
async function readBody(req, maxBytes) {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > maxBytes) throw bodyTooLarge()
  const chunks = []
  let total = 0
  let overflowed = false
  try {
    for await (const chunk of req) {
      total += chunk.length
      if (total > maxBytes) {
        // Stop the transfer instead of reading a body we will discard.
        overflowed = true
        req.destroy()
        break
      }
      chunks.push(chunk)
    }
  } catch (error) {
    if (!overflowed) throw error
  }
  if (overflowed) throw bodyTooLarge()
  return Buffer.concat(chunks)
}

/** @returns {Error} The error {@link readBody} raises for an oversized body. */
function bodyTooLarge() {
  const error = new Error('request body is larger than this route accepts')
  error.code = 'BODY_TOO_LARGE'
  return error
}

/**
 * Read and parse a JSON request body.
 * @param {import('node:http').IncomingMessage} req - Request being read.
 * @returns {Promise<unknown>} The parsed value.
 * @throws {Error} With `code` `BAD_JSON` when the body is not a JSON object.
 */
async function readJson(req) {
  const raw = await readBody(req, MAX_JSON_BYTES)
  let parsed
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    const error = new Error('request body is not JSON')
    error.code = 'BAD_JSON'
    throw error
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    const error = new Error('request body must be a JSON object')
    error.code = 'BAD_JSON'
    throw error
  }
  return parsed
}

/**
 * The media type of an upload, without parameters.
 * @param {import('node:http').IncomingMessage} req - Request being read.
 * @returns {string} Lower-cased media type, or `''` when absent.
 */
function uploadMime(req) {
  const header = req.headers['content-type']
  if (typeof header !== 'string') return ''
  return header.split(';')[0].trim().toLowerCase()
}

/**
 * The display name an upload carries, percent-decoded and normalized.
 * @param {import('node:http').IncomingMessage} req - Request being read.
 * @returns {string} The accepted name, or the unnamed fallback.
 */
function uploadName(req) {
  const header = req.headers['x-background-name']
  if (typeof header !== 'string') return UNNAMED
  let decoded
  try {
    decoded = decodeURIComponent(header)
  } catch {
    decoded = header
  }
  return normalizeName(decoded) ?? UNNAMED
}

/**
 * Register the library routes for the plugin's lifetime.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context carrying the web server and logger.
 * @param {unknown} config - The loader row's config object.
 * @returns {Promise<void>} Resolves once the store is open and the route is registered.
 */
export async function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const dir = resolved.dataDir === '' ? defaultDataDir() : expandHome(resolved.dataDir)
  const store = await createStore({
    dir,
    warn: message => { ctx.logger.warn(`background-swapper: ${message}`) },
  })

  /** The library payload the browser half reads. */
  const library = () => ({
    ok: true,
    items: store.list(),
    ...store.settings(),
    // The slider positions a library with no stored preferences reports. The
    // panel's Reset controls land here, so both halves read one definition.
    defaults: {
      tint: DEFAULT_SETTINGS.tint,
      opacity: DEFAULT_SETTINGS.opacity,
      blur: DEFAULT_SETTINGS.blur,
    },
    limits: {
      pageSize: resolved.pageSize,
      maxImageBytes: resolved.maxImageBytes,
      maxDimension: resolved.maxDimension,
      maxNameLength: MAX_NAME_LENGTH,
    },
  })

  /**
   * `GET /list` — the library, the settings, and the limits one call.
   * @param {import('node:http').IncomingMessage} req - Request being handled.
   * @param {import('node:http').ServerResponse} res - Response to own.
   */
  const handleList = (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res, 'GET, HEAD')
    writeJson(res, 200, library(), req.method === 'HEAD')
  }

  /**
   * `PATCH /state` — replace whichever settings the body names.
   * @param {import('node:http').IncomingMessage} req - Request being handled.
   * @param {import('node:http').ServerResponse} res - Response to own.
   * @returns {Promise<void>} Resolves after the response is written.
   */
  const handleState = async (req, res) => {
    if (req.method !== 'PATCH') return methodNotAllowed(res, 'PATCH')
    const body = /** @type {Record<string, unknown>} */ (await readJson(req))
    /** @type {{ activeId?: string | null, tint?: number, opacity?: number, blur?: number }} */
    const patch = {}
    if ('activeId' in body) {
      const activeId = body.activeId
      if (activeId !== null && typeof activeId !== 'string') {
        return writeText(res, 400, 'activeId must be a background id or null')
      }
      if (activeId !== null && store.get(activeId) === undefined) {
        return writeText(res, 400, 'activeId names no background in this library')
      }
      patch.activeId = activeId
    }
    if ('tint' in body) {
      const tint = normalizeTint(body.tint)
      if (tint === undefined) return writeText(res, 400, 'tint must be a number from -1 to 1')
      patch.tint = tint
    }
    if ('opacity' in body) {
      const opacity = normalizeOpacity(body.opacity)
      if (opacity === undefined) return writeText(res, 400, 'opacity must be a number from 0 to 1')
      patch.opacity = opacity
    }
    if ('blur' in body) {
      const blur = normalizeBlur(body.blur)
      if (blur === undefined) return writeText(res, 400, 'blur must be a number from 0 to 24')
      patch.blur = blur
    }
    await store.updateSettings(patch)
    writeJson(res, 200, library())
  }

  /**
   * `POST /images` — store one uploaded image and make it active.
   * `DELETE /images` — remove every stored image.
   * @param {import('node:http').IncomingMessage} req - Request being handled.
   * @param {import('node:http').ServerResponse} res - Response to own.
   * @returns {Promise<void>} Resolves after the response is written.
   */
  const handleImages = async (req, res) => {
    if (req.method === 'DELETE') {
      const removed = await store.clear()
      return writeJson(res, 200, { ok: true, removed, ...store.settings() })
    }
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST, DELETE')
    const mime = uploadMime(req)
    if (!IMAGE_TYPES.has(mime)) {
      // SVG is refused deliberately: an uploaded document served from the
      // application's own origin is a script-injection surface.
      return writeText(res, 415, `content-type must be one of ${[...IMAGE_TYPES.keys()].join(', ')}`)
    }
    const bytes = await readBody(req, resolved.maxImageBytes)
    if (bytes.length === 0) return writeText(res, 400, 'the request carried no image bytes')
    const item = await store.add({ name: uploadName(req), mime, bytes })
    writeJson(res, 201, { ok: true, item, ...store.settings() })
  }

  /**
   * `GET`, `PATCH`, and `DELETE` on one image.
   * @param {import('node:http').IncomingMessage} req - Request being handled.
   * @param {import('node:http').ServerResponse} res - Response to own.
   * @param {string} id - Decoded item identifier from the path.
   * @returns {Promise<void>} Resolves after the response is written.
   */
  const handleImage = async (req, res, id) => {
    const item = store.get(id)
    if (item === undefined) return notFound(res)

    if (req.method === 'GET' || req.method === 'HEAD') {
      const path = store.imagePath(item)
      let size
      try {
        size = (await stat(path)).size
      } catch {
        return notFound(res)
      }
      res.writeHead(200, {
        'content-type': item.mime,
        'content-length': size,
        'cache-control': 'public, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
      })
      if (req.method === 'HEAD') return res.end()
      const stream = createReadStream(path)
      stream.on('error', () => { res.destroy() })
      return new Promise((resolve) => {
        stream.pipe(res)
        res.on('close', resolve)
        res.on('finish', resolve)
      })
    }

    if (req.method === 'PATCH') {
      const body = /** @type {Record<string, unknown>} */ (await readJson(req))
      const name = normalizeName(body.name)
      if (name === undefined) return writeText(res, 400, `name must be 1 to ${MAX_NAME_LENGTH} usable characters`)
      const renamed = await store.rename(id, name)
      if (renamed === undefined) return notFound(res)
      return writeJson(res, 200, { ok: true, item: renamed })
    }

    if (req.method === 'DELETE') {
      await store.remove(id)
      return writeJson(res, 200, { ok: true, ...store.settings() })
    }

    return methodNotAllowed(res, 'GET, HEAD, PATCH, DELETE')
  }

  /**
   * Route one request under the plugin's prefix.
   * @param {import('node:http').IncomingMessage} req - Request being handled.
   * @param {import('node:http').ServerResponse} res - Response to own.
   * @returns {Promise<void>} Resolves after the response is written.
   */
  const handle = async (req, res) => {
    try {
      const path = new URL(req.url ?? '/', 'http://dsh.invalid').pathname
      if (path === LIST_ROUTE) return await handleList(req, res)
      if (path === STATE_ROUTE) return await handleState(req, res)
      if (path === IMAGES_ROUTE) return await handleImages(req, res)
      if (path.startsWith(`${IMAGES_ROUTE}/`)) {
        let id
        try {
          id = decodeURIComponent(path.slice(IMAGES_ROUTE.length + 1))
        } catch {
          return notFound(res)
        }
        // The id addresses an index record; it never reaches the filesystem.
        if (id === '' || id.includes('/')) return notFound(res)
        return await handleImage(req, res, id)
      }
      return notFound(res)
    } catch (error) {
      if (res.headersSent) return res.destroy()
      if (error?.code === 'BODY_TOO_LARGE') {
        return writeText(res, 413, `the body exceeds the accepted ${String(resolved.maxImageBytes)} bytes`)
      }
      if (error?.code === 'BAD_JSON') return writeText(res, 400, error.message)
      ctx.logger.warn(`background-swapper: ${req.method ?? 'request'} ${req.url ?? ''} failed: ${String(error)}`)
      return writeText(res, 500, 'the background library could not complete this request')
    }
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler: handle }),
    `background-swapper: route ${ROUTE}`,
  )

  ctx.logger.info?.(`background-swapper: library at ${dir}`)
}
