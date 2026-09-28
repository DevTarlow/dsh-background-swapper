/**
 * On-disk background library for the Background Swapper host half.
 *
 * The library is one JSON index beside the image files it describes:
 *
 * ```text
 * <dir>/index.json          { version, items[], activeId, tint, backgroundOpacity, elementOpacity, blur }
 * <dir>/images/<id>.<ext>   one file per item, named by the item's opaque id
 * ```
 *
 * The display name a person typed is data in the index, never part of a
 * pathname, so no accepted name can escape the directory. Every mutation is
 * serialized on one promise chain and published with a temporary file plus a
 * rename, so a crash cannot leave a truncated index behind.
 *
 * @module dsh-background-swapper/store
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Index format this module reads and writes. */
export const STORE_VERSION = 1

/** Largest display name kept, in characters. */
export const MAX_NAME_LENGTH = 80

/** Accepted upload media types mapped to the file extension each is stored under. */
export const IMAGE_TYPES = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
  ['image/avif', 'avif'],
])

/**
 * Settings defaults, also the values a fresh library reports.
 *
 * Both alphas start below 1 on purpose: at 1 a layer's surfaces are exactly as
 * opaque as the stock interface, so a newly added photo would be completely
 * hidden behind it and the plugin would look broken. They are kept apart
 * because they fade different layers: `backgroundOpacity` the ground the frame
 * and body paint, `elementOpacity` the panels, cards and menus raised above it,
 * so the photo can fill the ground while the surfaces over it stay readable.
 */
export const DEFAULT_SETTINGS = Object.freeze({
  activeId: null,
  tint: 0,
  backgroundOpacity: 0.5,
  elementOpacity: 0.5,
  blur: 0,
})

/**
 * The appearance preferences stored beside the library.
 * @typedef {object} Settings
 * @property {string | null} activeId - Background currently painted, or null for none.
 * @property {number} tint - Darken-to-lighten wash over the photo, from -1 to 1.
 * @property {number} backgroundOpacity - Alpha of the ground behind the interface, from 0 to 1.
 * @property {number} elementOpacity - Alpha of the panels, cards and menus raised over that ground, from 0 to 1.
 * @property {number} blur - Photo blur radius in pixels, from 0 to 24.
 */

/**
 * One stored background's metadata.
 * @typedef {object} BackgroundItem
 * @property {string} id - Opaque identifier; also the image file's base name.
 * @property {string} name - Display name the person typed.
 * @property {string} file - Image file name below `<dir>/images/`.
 * @property {string} mime - Media type the file is served with.
 * @property {number} bytes - Stored file size in bytes.
 * @property {number} addedAt - Creation time as epoch milliseconds.
 */

/**
 * Trim a typed name to a value the index accepts.
 * @param {unknown} raw - Candidate name.
 * @returns {string | undefined} The trimmed name, or undefined when it is empty after trimming.
 */
export function normalizeName(raw) {
  if (typeof raw !== 'string') return undefined
  // Control characters would survive into a rendered caption and a download
  // name; drop them rather than reject an otherwise usable name.
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim()
  if (cleaned === '') return undefined
  return cleaned.length > MAX_NAME_LENGTH ? cleaned.slice(0, MAX_NAME_LENGTH) : cleaned
}

/**
 * Read a bounded numeric setting.
 * @param {unknown} value - Candidate value.
 * @param {number} min - Smallest accepted value.
 * @param {number} max - Largest accepted value.
 * @returns {number | undefined} The value, or undefined when it is not a finite number in range.
 */
function normalizeNumber(value, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  if (value < min || value > max) return undefined
  return value
}

/** @param {unknown} value - Candidate tint. @returns {number | undefined} Tint in -1..1, or undefined. */
export function normalizeTint(value) {
  return normalizeNumber(value, -1, 1)
}

/** @param {unknown} value - Candidate alpha. @returns {number | undefined} Surface alpha in 0..1, or undefined. */
export function normalizeOpacity(value) {
  return normalizeNumber(value, 0, 1)
}

/** @param {unknown} value - Candidate blur. @returns {number | undefined} Blur radius in 0..24 pixels, or undefined. */
export function normalizeBlur(value) {
  return normalizeNumber(value, 0, 24)
}

/**
 * Rebuild one item from stored JSON.
 * @param {unknown} raw - Candidate value from the index.
 * @returns {BackgroundItem | undefined} The item, or undefined when a required field is missing or wrong.
 */
function parseItem(raw) {
  if (typeof raw !== 'object' || raw === null) return undefined
  const { id, name, file, mime, bytes, addedAt } = /** @type {Record<string, unknown>} */ (raw)
  if (typeof id !== 'string' || id === '') return undefined
  if (typeof name !== 'string' || name === '') return undefined
  if (typeof file !== 'string' || file === '') return undefined
  if (typeof mime !== 'string' || !IMAGE_TYPES.has(mime)) return undefined
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return undefined
  if (typeof addedAt !== 'number' || !Number.isFinite(addedAt)) return undefined
  return { id, name, file, mime, bytes, addedAt }
}

/**
 * Open the library under `dir`, creating it on first use.
 * @param {object} options - Store configuration.
 * @param {string} options.dir - Absolute library directory.
 * @param {(message: string) => void} options.warn - Receives one line per discarded record.
 * @returns {Promise<object>} The store described by {@link createStore}'s documented methods.
 */
export async function createStore({ dir, warn }) {
  const indexPath = join(dir, 'index.json')
  const imagesDir = join(dir, 'images')

  /** @type {BackgroundItem[]} */
  let items = []
  /** @type {Settings} */
  let settings = { ...DEFAULT_SETTINGS }
  let writeChain = Promise.resolve()

  await mkdir(imagesDir, { recursive: true })
  await load()

  /** Read the index, discarding anything unreadable, foreign, or missing its image file. */
  async function load() {
    let raw
    try {
      raw = await readFile(indexPath, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') warn(`index unreadable (${String(error.code)}); starting empty`)
      return
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      warn('index is not JSON; starting empty')
      return
    }
    if (typeof parsed !== 'object' || parsed === null) {
      warn('index is not an object; starting empty')
      return
    }
    if (parsed.version !== STORE_VERSION) {
      warn(`index version ${String(parsed.version)} is not ${STORE_VERSION}; starting empty`)
      return
    }
    const candidates = Array.isArray(parsed.items) ? parsed.items : []
    let discarded = 0
    const kept = []
    for (const candidate of candidates) {
      const item = parseItem(candidate)
      if (item === undefined || !await isFile(join(imagesDir, item.file))) {
        discarded += 1
        continue
      }
      kept.push(item)
    }
    items = kept
    settings = {
      activeId: typeof parsed.activeId === 'string' && kept.some(item => item.id === parsed.activeId)
        ? parsed.activeId
        : null,
      tint: normalizeTint(parsed.tint) ?? DEFAULT_SETTINGS.tint,
      backgroundOpacity: normalizeOpacity(parsed.backgroundOpacity) ?? DEFAULT_SETTINGS.backgroundOpacity,
      // An index written before the two sliders were split stored one alpha for
      // every surface. It becomes the element alpha, which is the layer it
      // mostly controlled; the ground takes the shipped default.
      elementOpacity: normalizeOpacity(parsed.elementOpacity ?? parsed.opacity) ?? DEFAULT_SETTINGS.elementOpacity,
      blur: normalizeBlur(parsed.blur) ?? DEFAULT_SETTINGS.blur,
    }
    if (discarded > 0) warn(`discarded ${String(discarded)} index record(s) that had no usable image`)
  }

  /**
   * Report whether a path is a regular file.
   * @param {string} path - Absolute path to test.
   * @returns {Promise<boolean>} True only for an existing regular file.
   */
  async function isFile(path) {
    try {
      return (await stat(path)).isFile()
    } catch {
      return false
    }
  }

  /** Publish the index through a temporary file so a crash cannot truncate it. */
  function persist() {
    const document = JSON.stringify({ version: STORE_VERSION, items, ...settings }, null, 2)
    return writeFile(`${indexPath}.tmp`, `${document}\n`, 'utf8')
      .then(() => rename(`${indexPath}.tmp`, indexPath))
  }

  /**
   * Run one mutation with persistence, serialized against every other mutation.
   * @template T
   * @param {() => T | Promise<T>} mutate - Mutation returning the caller's result.
   * @param {boolean} [durable] - Whether to persist after the mutation (default true).
   * @returns {Promise<T>} The mutation's result.
   */
  function serialize(mutate, durable = true) {
    const run = writeChain.then(async () => {
      const result = await mutate()
      if (durable) await persist()
      return result
    })
    // Each caller owns its own rejection; the chain only needs to keep order.
    writeChain = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * One item by id.
   * @param {unknown} id - Candidate identifier.
   * @returns {BackgroundItem | undefined} The item, or undefined when no item has that id.
   */
  function get(id) {
    return typeof id === 'string' ? items.find(item => item.id === id) : undefined
  }

  return {
    dir,

    /**
     * Every item, newest first.
     * @returns {BackgroundItem[]} A detached copy in display order.
     */
    list() {
      return [...items].sort((left, right) => right.addedAt - left.addedAt).map(item => ({ ...item }))
    },

    /** @param {unknown} id - Candidate identifier. @returns {BackgroundItem | undefined} The item, or undefined. */
    get,

    /**
     * Absolute path of an item's image file.
     * @param {BackgroundItem} item - Stored item.
     * @returns {string} Path inside the library's images directory.
     */
    imagePath(item) {
      return join(imagesDir, item.file)
    },

    /**
     * Store a new image and make it the active background.
     * @param {{ name: string, mime: string, bytes: Buffer }} input - Validated upload.
     * @returns {Promise<BackgroundItem>} The created item.
     */
    async add({ name, mime, bytes }) {
      const extension = IMAGE_TYPES.get(mime)
      if (extension === undefined) throw new Error(`store: ${mime} is not a supported image type`)
      const id = randomUUID()
      const file = `${id}.${extension}`
      const item = { id, name, file, mime, bytes: bytes.length, addedAt: Date.now() }
      return serialize(async () => {
        await writeFile(join(imagesDir, file), bytes)
        items.push(item)
        settings.activeId = id
        return { ...item }
      })
    },

    /**
     * Rename an item.
     * @param {unknown} id - Identifier of the item to rename.
     * @param {string} name - Already-normalized display name.
     * @returns {Promise<BackgroundItem | undefined>} The updated item, or undefined when no item has that id.
     */
    async rename(id, name) {
      if (get(id) === undefined) return undefined
      return serialize(() => {
        const item = get(id)
        item.name = name
        return { ...item }
      })
    },

    /**
     * Delete an item and its file, clearing the active background when it pointed there.
     * @param {unknown} id - Identifier of the item to delete.
     * @returns {Promise<boolean>} True when an item was removed.
     */
    async remove(id) {
      if (get(id) === undefined) return false
      return serialize(async () => {
        const index = items.findIndex(item => item.id === id)
        const [item] = items.splice(index, 1)
        if (settings.activeId === item.id) settings.activeId = null
        // A missing file is not a failure: the index no longer references it.
        await unlink(join(imagesDir, item.file)).catch(() => undefined)
        return true
      })
    },

    /**
     * Delete every item and its file, leaving the slider preferences untouched.
     * @returns {Promise<number>} How many items were removed.
     */
    async clear() {
      return serialize(async () => {
        const removed = items
        items = []
        settings.activeId = null
        for (const item of removed) {
          await unlink(join(imagesDir, item.file)).catch(() => undefined)
        }
        return removed.length
      })
    },

    /**
     * Current settings.
     * @returns {Settings} A detached copy.
     */
    settings() {
      return { ...settings }
    },

    /**
     * Apply a validated settings patch.
     * @param {{ activeId?: string | null, tint?: number, backgroundOpacity?: number, elementOpacity?: number, blur?: number }} patch - Fields to replace.
     * @returns {Promise<Settings>} The new settings.
     * @throws {Error} When `activeId` names an item that does not exist.
     */
    async updateSettings(patch) {
      return serialize(() => {
        if ('activeId' in patch) {
          const next = patch.activeId ?? null
          if (next !== null && get(next) === undefined) throw new Error(`store: no background ${next}`)
          settings.activeId = next
        }
        if (patch.tint !== undefined) settings.tint = patch.tint
        if (patch.backgroundOpacity !== undefined) settings.backgroundOpacity = patch.backgroundOpacity
        if (patch.elementOpacity !== undefined) settings.elementOpacity = patch.elementOpacity
        if (patch.blur !== undefined) settings.blur = patch.blur
        return { ...settings }
      })
    },
  }
}
