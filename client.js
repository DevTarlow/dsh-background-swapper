/**
 * Background Swapper browser half.
 *
 * Registers two contributions and nothing else:
 *
 * - `shell.overlay`  the always-mounted painter, which renders one `<style>`
 *                    element holding the active background rules;
 * - `sidebar.footer.action`  the "Swap Background" row above Settings, which
 *                    opens the anchored panel that drives everything.
 *
 * The module requests `react` (a platform seed word) and no other package, so
 * it depends on no Harness Client module that can change under it. Every style
 * it writes is either a theme token or a `color-mix()` of one, and every effect
 * it creates lives in the React tree, so unmounting the plugin restores the
 * interface exactly.
 */
window.__ModuleLoader__.load({
  id: 'dsh-background-swapper',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    /** Host route prefix owned by this plugin's other half. */
    const ROUTE = '/__background-swapper'

    /** Accepted upload media types, mirroring the host half's stored extensions. */
    const ACCEPTED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'])

    /** How long a slider rests before its value is written to the host. */
    const PERSIST_DELAY_MS = 400

    /** Panel width in pixels; also the value the placement math clamps against. */
    const PANEL_WIDTH = 360

    /** Every piece of user-visible copy, so a later locale pass starts in one place. */
    const STRINGS = {
      trigger: 'Swap Background',
      title: 'Background',
      close: 'Close',
      current: 'Current',
      noBackground: 'No background',
      turnOff: 'Turn off',
      appearance: 'Appearance',
      addPhoto: 'Add a photo',
      dropHint: 'Drop a photo here',
      chooseFile: 'Choose file',
      name: 'Name',
      save: 'Save',
      cancel: 'Cancel',
      recent: 'Recent',
      empty: 'No photos yet — add one above.',
      page: (page, total) => `Page ${page} of ${total}`,
      previous: 'Previous page',
      next: 'Next page',
      renameNamed: name => `Rename ${name}`,
      deleteNamed: name => `Delete ${name}`,
      deleteQuestion: 'Delete?',
      yes: 'Yes',
      no: 'No',
      tint: 'Tint',
      tintNone: 'None',
      tintDarken: percent => `Darken ${percent}%`,
      tintLighten: percent => `Lighten ${percent}%`,
      presets: 'Presets',
      presetsHint: 'Sets the three opacity sliders. Tint and Blur are left alone.',
      presetWallpaper: 'Wallpaper',
      presetGlass: 'Glass',
      presetSolid: 'Solid',
      presetTitle: (background, elements, sidebar) =>
        `Background ${background}%, Elements ${elements}%, Sidebar ${sidebar}%`,
      presetSave: 'Save current',
      presetSaveTitle: 'Save the three opacity sliders as a look of your own',
      presetFullHint: max => `That is all ${max} saved looks. Remove one to save another.`,
      presetNameLabel: 'Look name',
      presetSuggest: 'My look',
      presetDeleteNamed: name => `Delete ${name}`,
      backgroundOpacity: 'Background opacity',
      backgroundHint: 'Lower shows more photo in the open page.',
      elementOpacity: 'Element opacity',
      elementHint: 'Higher keeps the cards and menus readable.',
      sidebarOpacity: 'Sidebar opacity',
      sidebarHint: 'How solid the left column is, on its own.',
      solidHint: 'Everything is fully opaque, so the photo is hidden. Lower Background opacity to see it.',
      blur: 'Blur',
      reset: 'Reset',
      removeAll: 'Remove all photos',
      removeAllQuestion: 'Remove all?',
      loading: 'Loading…',
      retry: 'Retry',
      preparing: 'Preparing…',
      uploading: 'Uploading…',
      resized: pixels => `Resized to ${pixels} px on the long edge.`,
      on: 'On',
      off: 'Off',
    }

    /** Smallest alpha percent applied to surfaces that must stay readable. */
    const OVERLAY_FLOOR = 90

    /**
     * The ground the frame and body paint, faded by the Background opacity
     * slider. It is the one surface the photo lies directly under, so this is
     * the slider that decides how much of the photo the open page shows.
     */
    const BACKGROUND_TOKENS = [
      ['--dsw-alias-bg-base', '00', '950', 0],
    ]

    /**
     * The surfaces raised over that ground, faded by the Element opacity
     * slider: cards, inputs, code blocks and menus. Each carries the static
     * palette tone it maps to and the smallest alpha it may take, so a dialog
     * or menu cannot be faded into unreadability.
     */
    const ELEMENT_TOKENS = [
      ['--dsw-alias-bg-layer-1', '00', '875', 0],
      ['--dsw-alias-bg-layer-2', '00', '850', 0],
      ['--dsw-alias-bg-layer-3', '00', '800', 0],
      ['--dsw-alias-bg-overlay', '150', '700', OVERLAY_FLOOR],
    ]

    /**
     * The left column, faded by the Sidebar opacity slider. It is one token
     * rather than a group, but it is the largest piece of chrome and the one
     * people most often want solid while the panels stay glassy, so it gets its
     * own alpha instead of riding the element one.
     */
    const SIDEBAR_TOKENS = [
      ['--dsw-specific-sidebar-fill', '50', '900', 0],
    ]

    /**
     * One-click balances of the three alphas, so the layers can be set without
     * hunting for the crossing point where the photo reads and the panels stay
     * legible. Tint and Blur are deliberately left alone: they belong to the
     * photo, and a preset must not undo a photo someone already tuned. Looks
     * someone saves of their own live beside these and keep to the same
     * contract, which is what makes loading one after trying Glass restore
     * everything Glass could have changed.
     *
     * Wallpaper repeats the shipped defaults in `store.js`, which is why a
     * fresh library and a Reset both light it up.
     */
    const BUILT_IN_PRESETS = [
      {
        id: 'wallpaper',
        name: STRINGS.presetWallpaper,
        backgroundOpacity: 0.2,
        elementOpacity: 0.85,
        sidebarOpacity: 0.85,
      },
      {
        id: 'glass',
        name: STRINGS.presetGlass,
        backgroundOpacity: 0.05,
        elementOpacity: 0.5,
        sidebarOpacity: 0.5,
      },
      {
        id: 'solid',
        name: STRINGS.presetSolid,
        backgroundOpacity: 1,
        elementOpacity: 1,
        sidebarOpacity: 1,
      },
    ]

    /**
     * Whether the current alphas are exactly a preset's, so the row can say
     * which balance is on and go quiet as soon as one is adjusted by hand.
     * @param {object} state - Current snapshot.
     * @param {typeof BUILT_IN_PRESETS[number]} preset - Preset to test.
     * @returns {boolean} True when every slider sits on the preset's value.
     */
    function isPresetActive(state, preset) {
      return alphaPercent(state.backgroundOpacity) === alphaPercent(preset.backgroundOpacity)
        && alphaPercent(state.elementOpacity) === alphaPercent(preset.elementOpacity)
        && alphaPercent(state.sidebarOpacity) === alphaPercent(preset.sidebarOpacity)
    }

    /**
     * Apply a preset's alphas in one write, so the layers move together.
     * @param {typeof BUILT_IN_PRESETS[number]} preset - Preset to apply.
     */
    function applyPreset(preset) {
      const patch = {
        backgroundOpacity: preset.backgroundOpacity,
        elementOpacity: preset.elementOpacity,
        sidebarOpacity: preset.sidebarOpacity,
      }
      publish(patch)
      persistSettings(patch)
    }

    /**
     * A label no saved look already uses, so a new one is never confused with
     * one someone is looking for by name.
     * @param {Array<{ name: string }>} presets - Saved looks.
     * @returns {string} The suggested name.
     */
    function suggestedPresetName(presets) {
      const taken = new Set(presets.map(preset => preset.name))
      if (!taken.has(STRINGS.presetSuggest)) return STRINGS.presetSuggest
      for (let index = 2; ; index += 1) {
        const candidate = `${STRINGS.presetSuggest} ${index}`
        if (!taken.has(candidate)) return candidate
      }
    }

    /**
     * An identifier no saved look already uses. It only has to be unique inside
     * one library, so a timestamp and a little noise are enough and need no
     * cryptographic source.
     * @param {Array<{ id: string }>} presets - Saved looks.
     * @returns {string} A fresh identifier.
     */
    function newPresetId(presets) {
      const taken = new Set(presets.map(preset => preset.id))
      let id
      do {
        id = `look-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
      } while (taken.has(id))
      return id
    }

    /**
     * Placeholder settings and slider defaults used only until the host answers
     * with the real ones. The host owns both values: this pair exists so the
     * panel can paint something coherent during the first request, and it is
     * overwritten by the first `GET /list` that resolves.
     */
    const UNKNOWN = Object.freeze({
      settings: Object.freeze({
        tint: 0, backgroundOpacity: 0.5, elementOpacity: 0.5, sidebarOpacity: 0.5, blur: 0,
      }),
      limits: Object.freeze({
        pageSize: 6, maxImageBytes: 16 * 1024 * 1024, maxDimension: 2560, maxNameLength: 80,
        maxPresets: 6, maxPresetNameLength: 24,
      }),
    })

    // ── shared state ────────────────────────────────────────────────────────

    /** The one snapshot both contributions render from. */
    let snapshot = {
      status: 'loading',
      items: [],
      activeId: null,
      presets: [],
      ...UNKNOWN.settings,
      defaults: UNKNOWN.settings,
      limits: UNKNOWN.limits,
      error: null,
    }
    const listeners = new Set()

    /** Replace the snapshot and wake every subscriber. */
    function publish(patch) {
      snapshot = { ...snapshot, ...patch }
      for (const listener of [...listeners]) listener()
    }

    /** Subscribe one component to snapshot replacement. */
    function subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }

    /** Read the snapshot into component state. */
    function useSnapshot() {
      const [value, setValue] = useState(snapshot)
      useEffect(() => subscribe(() => { setValue(snapshot) }), [])
      return value
    }

    /** A thrown value's message. */
    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    /** Consume a drag the panel cannot use, so the browser never opens the file. */
    function swallowDrag(event) {
      event.preventDefault()
    }

    /** Whether a payload member carries a complete set of slider defaults. */
    function isSettings(value) {
      return typeof value === 'object' && value !== null
        && typeof value.tint === 'number' && typeof value.backgroundOpacity === 'number'
        && typeof value.elementOpacity === 'number' && typeof value.sidebarOpacity === 'number'
        && typeof value.blur === 'number'
    }

    // ── host transport ──────────────────────────────────────────────────────

    /** Address one stored image. */
    function imageUrl(id) {
      return `${ROUTE}/images/${encodeURIComponent(id)}`
    }

    /**
     * One JSON request against the host half; failures carry the host's own line.
     * @param {string} path - Path below the plugin prefix.
     * @param {object} [options] - fetch options.
     */
    async function api(path, options) {
      let response
      try {
        response = await fetch(`${ROUTE}${path}`, { cache: 'no-store', ...options })
      } catch (error) {
        throw new Error(`Cannot reach the background library: ${messageOf(error)}`)
      }
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new Error(detail.trim() === '' ? `The library answered ${response.status}.` : detail.trim())
      }
      return await response.json()
    }

    /** Fold a library payload into the snapshot. */
    function absorb(payload) {
      publish({
        status: 'ready',
        items: Array.isArray(payload.items) ? payload.items : [],
        activeId: typeof payload.activeId === 'string' ? payload.activeId : null,
        presets: Array.isArray(payload.presets) ? payload.presets : [],
        tint: typeof payload.tint === 'number' ? payload.tint : UNKNOWN.settings.tint,
        backgroundOpacity: typeof payload.backgroundOpacity === 'number'
          ? payload.backgroundOpacity
          : UNKNOWN.settings.backgroundOpacity,
        elementOpacity: typeof payload.elementOpacity === 'number'
          ? payload.elementOpacity
          : UNKNOWN.settings.elementOpacity,
        sidebarOpacity: typeof payload.sidebarOpacity === 'number'
          ? payload.sidebarOpacity
          : UNKNOWN.settings.sidebarOpacity,
        blur: typeof payload.blur === 'number' ? payload.blur : UNKNOWN.settings.blur,
        defaults: isSettings(payload.defaults) ? payload.defaults : snapshot.defaults,
        limits: payload.limits === undefined ? snapshot.limits : { ...snapshot.limits, ...payload.limits },
        error: null,
      })
    }

    /** Read the whole library. */
    async function load() {
      try {
        absorb(await api('/list'))
      } catch (error) {
        publish({ status: 'ready', error: messageOf(error) })
      }
    }

    /** Run one mutation, reporting a failure into the panel's alert line. */
    async function attempt(work) {
      try {
        return await work()
      } catch (error) {
        publish({ error: messageOf(error) })
        return undefined
      }
    }

    /** Debounced settings write, so a slider drag persists once. */
    let pendingSettings = null
    let settingsTimer = null
    function persistSettings(patch) {
      pendingSettings = { ...pendingSettings, ...patch }
      if (settingsTimer !== null) clearTimeout(settingsTimer)
      settingsTimer = setTimeout(() => {
        const body = pendingSettings
        pendingSettings = null
        settingsTimer = null
        if (body === null) return
        void attempt(async () => {
          await api('/state', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
          // The local value is already applied; only the alert line is stale.
          if (snapshot.error !== null) publish({ error: null })
        })
      }, PERSIST_DELAY_MS)
    }

    // ── background painting ─────────────────────────────────────────────────

    /** A 0-1 alpha as the whole-number percent `color-mix()` takes. */
    function alphaPercent(value) {
      return Math.max(0, Math.min(100, Math.round(value * 100)))
    }

    /**
     * Mix one group of surface aliases from the stock palette tone at an alpha.
     * @param {number} percent - Alpha to paint the whole group at, 0-100.
     * @param {ReadonlyArray<readonly [string, string, string, number]>} tokens - Alias, light tone, dark tone, and the smallest alpha it may take.
     * @returns {{ light: string[], dark: string[] }} Declarations for the light and the dark theme.
     */
    function surfaceRules(percent, tokens) {
      const light = []
      const dark = []
      for (const [alias, lightTone, darkTone, floor] of tokens) {
        // The slider is a preference, not a measured composited alpha: several
        // tokens are painted by nested surfaces, so the stacked result reads
        // denser than the number. A token's floor overrides it where the
        // surface has to stay legible.
        const tone = Math.max(floor, percent)
        light.push(`${alias}: color-mix(in srgb, var(--dsw-static-neutral-bluish-${lightTone}) ${tone}%, transparent);`)
        dark.push(`${alias}: color-mix(in srgb, var(--dsw-static-neutral-bluish-${darkTone}) ${tone}%, transparent);`)
      }
      return { light, dark }
    }

    /**
     * The rules that paint the active photo and fade the two layers above it.
     * @param {object} state - Current snapshot.
     * @returns {string | null} CSS text, or null when no background is active.
     */
    function paintCss(state) {
      const item = state.items.find(candidate => candidate.id === state.activeId)
      if (item === undefined) return null
      const ground = surfaceRules(alphaPercent(state.backgroundOpacity), BACKGROUND_TOKENS)
      const elements = surfaceRules(alphaPercent(state.elementOpacity), ELEMENT_TOKENS)
      const sidebar = surfaceRules(alphaPercent(state.sidebarOpacity), SIDEBAR_TOKENS)
      const blur = Math.max(0, Math.min(24, state.blur))
      const tint = state.tint < 0
        ? `rgba(0, 0, 0, ${(-state.tint * 0.85).toFixed(3)})`
        : state.tint > 0
          ? `rgba(255, 255, 255, ${(state.tint * 0.85).toFixed(3)})`
          : 'transparent'
      // Overscan so the blur kernel never samples past the viewport edge.
      const pad = Math.ceil(blur * 2.5) + 8
      return [
        'html::before {',
        '  content: "";',
        '  position: fixed;',
        `  inset: -${pad}px;`,
        '  z-index: -1;',
        '  pointer-events: none;',
        `  background-image: linear-gradient(${tint}, ${tint}), url("${imageUrl(item.id)}");`,
        '  background-size: cover, cover;',
        '  background-position: center center, center center;',
        '  background-repeat: no-repeat, no-repeat;',
        `  filter: blur(${blur}px);`,
        '}',
        `body { ${[...ground.light, ...sidebar.light, ...elements.light].join(' ')} }`,
        `body[data-ds-dark-theme] { ${[...ground.dark, ...sidebar.dark, ...elements.dark].join(' ')} }`,
      ].join('\n')
    }

    /** Mount the active background's rules for as long as one is active. */
    function BackgroundPainter() {
      const state = useSnapshot()
      const css = useMemo(
        () => paintCss(state),
        [
          state.activeId, state.backgroundOpacity, state.elementOpacity, state.sidebarOpacity,
          state.blur, state.tint, state.items,
        ],
      )
      if (css === null) return null
      return h('style', { 'data-background-swapper': '' }, css)
    }

    // ── small presentational pieces ─────────────────────────────────────────

    /** Outline glyphs drawn inline, so no icon package is imported. */
    const ICONS = {
      picture: [
        ['rect', { x: 3, y: 4.5, width: 18, height: 15, rx: 2.5 }],
        ['circle', { cx: 8.6, cy: 9.8, r: 1.6 }],
        ['path', { d: 'M4.2 17.6 9.6 12l4 4 2.4-2.4L19.8 17.6' }],
      ],
      close: [['path', { d: 'M6.5 6.5 17.5 17.5' }], ['path', { d: 'M17.5 6.5 6.5 17.5' }]],
      left: [['path', { d: 'M14.5 6 9 12l5.5 6' }]],
      right: [['path', { d: 'M9.5 6 15 12l-5.5 6' }]],
      pencil: [['path', { d: 'M4 20h3.8L19 8.8a2.1 2.1 0 0 0-3-3L4.8 17z' }], ['path', { d: 'M14.8 6.6 17.4 9.2' }]],
      trash: [
        ['path', { d: 'M4.5 7h15' }],
        ['path', { d: 'M9.5 7V5.2h5V7' }],
        ['path', { d: 'M6.8 7l1 12.2h8.4L17.2 7' }],
        ['path', { d: 'M10.4 10.6v5.4' }],
        ['path', { d: 'M13.6 10.6v5.4' }],
      ],
    }

    /** One inline glyph. */
    function Icon({ name, size }) {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      }, ICONS[name].map(([tag, attrs], index) => h(tag, { key: index, ...attrs })))
    }

    /** One labelled range control with a readout and a reset. */
    function RangeRow({ label, hint, min, max, value, readout, onChange, onReset }) {
      return h('div', { className: 'dsh-bgs-range' },
        h('div', { className: 'dsh-bgs-rangeHead' },
          h('span', { className: 'dsh-bgs-rangeLabel' }, label),
          h('span', { className: 'dsh-bgs-rangeValue' }, readout),
          onReset === undefined ? null : h('button', {
            type: 'button',
            className: 'dsh-bgs-link',
            onClick: onReset,
          }, STRINGS.reset)),
        h('input', {
          type: 'range',
          className: 'dsh-bgs-slider',
          min,
          max,
          step: 1,
          value,
          'aria-label': label,
          onChange: event => { onChange(Number(event.target.value)) },
        }),
        hint === undefined ? null : h('p', { className: 'dsh-bgs-hint' }, hint))
    }

    // ── image preparation ───────────────────────────────────────────────────

    /** Decode a file into something drawable, with an explicit release. */
    async function decode(file) {
      if (typeof createImageBitmap === 'function') {
        const bitmap = await createImageBitmap(file)
        return { element: bitmap, width: bitmap.width, height: bitmap.height, release: () => { bitmap.close() } }
      }
      const url = URL.createObjectURL(file)
      try {
        const element = await new Promise((resolve, reject) => {
          const image = new Image()
          image.onload = () => { resolve(image) }
          image.onerror = () => { reject(new Error('the image could not be decoded')) }
          image.src = url
        })
        return {
          element,
          width: element.naturalWidth,
          height: element.naturalHeight,
          release: () => { URL.revokeObjectURL(url) },
        }
      } catch (error) {
        URL.revokeObjectURL(url)
        throw error
      }
    }

    /** Ask a canvas for one encoding, reporting whether the format was honoured. */
    function encode(canvas, type) {
      return new Promise((resolve) => {
        if (typeof canvas.toBlob !== 'function') return resolve(null)
        canvas.toBlob(blob => { resolve(blob !== null && blob.type === type ? blob : null) }, type, 0.9)
      })
    }

    /**
     * Cap a chosen photo's long edge, keeping animated GIFs untouched.
     * @returns {Promise<{ blob: Blob, type: string, resized: boolean }>} The bytes to upload.
     */
    async function prepare(file, limits) {
      if (!ACCEPTED_TYPES.has(file.type)) {
        throw new Error(`${file.type === '' ? 'That file' : file.type} is not an accepted image type.`)
      }
      const maxDimension = limits.maxDimension
      if (file.type === 'image/gif' || !Number.isFinite(maxDimension) || maxDimension <= 0) {
        return { blob: file, type: file.type, resized: false }
      }
      const decoded = await decode(file)
      try {
        const longest = Math.max(decoded.width, decoded.height)
        if (longest <= maxDimension) return { blob: file, type: file.type, resized: false }
        const scale = maxDimension / longest
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(decoded.width * scale))
        canvas.height = Math.max(1, Math.round(decoded.height * scale))
        const context = canvas.getContext('2d')
        if (context === null) return { blob: file, type: file.type, resized: false }
        context.drawImage(decoded.element, 0, 0, canvas.width, canvas.height)
        // WebP first: it is supported wherever the Harness runs and keeps alpha.
        const blob = await encode(canvas, 'image/webp') ?? await encode(canvas, 'image/jpeg')
        if (blob === null) return { blob: file, type: file.type, resized: false }
        return { blob, type: blob.type, resized: true }
      } finally {
        decoded.release()
      }
    }

    /** The name a chosen file suggests, trimmed to the host's limit. */
    function suggestedName(file, maxLength) {
      const stem = file.name.replace(/\.[^.]*$/u, '').trim()
      const fallback = stem === '' ? 'Background' : stem
      return fallback.length > maxLength ? fallback.slice(0, maxLength) : fallback
    }

    // ── the panel and its trigger ───────────────────────────────────────────

    /** The sidebar row and the anchored panel it opens. */
    function SwapBackground({ wide }) {
      const state = useSnapshot()
      const [open, setOpen] = useState(false)
      const [anchor, setAnchor] = useState(null)
      const [page, setPage] = useState(1)
      const [draft, setDraft] = useState(null)
      const [renaming, setRenaming] = useState(null)
      const [confirming, setConfirming] = useState(null)
      const [dragging, setDragging] = useState(false)
      // The naming step for a look being saved: null, or the half-typed name.
      const [savingPreset, setSavingPreset] = useState(null)

      const rootRef = useRef(null)
      const triggerRef = useRef(null)
      const bodyRef = useRef(null)
      const fileRef = useRef(null)
      const draftNameRef = useRef(null)
      const renameRef = useRef(null)
      const previewRef = useRef(null)
      const presetNameRef = useRef(null)

      // A draft's object URL must be released whether it is saved, cancelled, or
      // simply abandoned by closing the panel.
      useEffect(() => { previewRef.current = draft === null ? null : draft.preview }, [draft])
      useEffect(() => () => {
        if (previewRef.current !== null) URL.revokeObjectURL(previewRef.current)
      }, [])

      const pageCount = Math.max(1, Math.ceil(state.items.length / Math.max(1, state.limits.pageSize)))
      const current = Math.min(page, pageCount)
      const activeItem = state.items.find(item => item.id === state.activeId) ?? null

      // Place the panel against the trigger, clamped to the viewport.
      useEffect(() => {
        if (!open) return undefined
        const place = () => {
          const rect = rootRef.current?.getBoundingClientRect()
          if (rect === undefined) return
          const margin = 8
          const left = Math.max(margin, Math.min(rect.left, window.innerWidth - PANEL_WIDTH - margin))
          const bottom = Math.max(margin, window.innerHeight - rect.top + 8)
          setAnchor({ left, bottom, maxHeight: Math.max(240, window.innerHeight - bottom - margin) })
        }
        place()
        window.addEventListener('resize', place)
        return () => { window.removeEventListener('resize', place) }
      }, [open])

      // Dismiss on an outside pointer or Escape, and hand focus back on close.
      useEffect(() => {
        if (!open) return undefined
        const onPointerDown = event => {
          if (rootRef.current !== null && rootRef.current.contains(event.target)) return
          setOpen(false)
        }
        const onKeyDown = event => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown)
        // While the drop target is on screen, a file dropped anywhere else must
        // not navigate the page to that file. These run after React's own
        // handlers, so another drop target still receives its drop first.
        window.addEventListener('dragover', swallowDrag)
        window.addEventListener('drop', swallowDrag)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown)
          window.removeEventListener('dragover', swallowDrag)
          window.removeEventListener('drop', swallowDrag)
          triggerRef.current?.focus()
        }
      }, [open])

      // The panel body exists only once placement has measured the trigger, so
      // its initial focus waits for that first anchor.
      useEffect(() => {
        if (open && anchor !== null) bodyRef.current?.focus()
      }, [open, anchor])

      // A rename in progress owns the keyboard until it is saved or cancelled.
      useEffect(() => {
        if (renaming === null) return
        renameRef.current?.focus()
        renameRef.current?.select()
      }, [renaming === null ? null : renaming.id])

      // The naming step appears with the keyboard in its field.
      useEffect(() => {
        if (draft === null || draft.busy) return
        draftNameRef.current?.focus()
        draftNameRef.current?.select()
      }, [draft === null])

      // The same for a look being saved, but only as it opens: re-selecting on
      // every keystroke would fight the person typing.
      useEffect(() => {
        if (savingPreset === null) return
        presetNameRef.current?.focus()
        presetNameRef.current?.select()
      }, [savingPreset === null])

      useEffect(() => { if (current !== page) setPage(current) }, [current, page])

      const chooseFile = useCallback(file => {
        if (file === undefined || file === null) return
        if (!ACCEPTED_TYPES.has(file.type)) {
          publish({ error: `${file.type === '' ? file.name : file.type} is not an accepted image type.` })
          return
        }
        setConfirming(null)
        setRenaming(null)
        setDraft(previous => {
          if (previous !== null) URL.revokeObjectURL(previous.preview)
          return {
            file,
            name: suggestedName(file, state.limits.maxNameLength),
            busy: false,
            note: '',
            preview: URL.createObjectURL(file),
          }
        })
      }, [state.limits.maxNameLength])

      const closeDraft = useCallback(() => {
        setDraft(previous => {
          if (previous !== null) URL.revokeObjectURL(previous.preview)
          return null
        })
      }, [])

      const saveDraft = useCallback(async () => {
        if (draft === null || draft.busy) return
        const name = draft.name.trim()
        if (name === '') return
        setDraft({ ...draft, busy: 'preparing' })
        try {
          const prepared = await prepare(draft.file, state.limits)
          if (prepared.blob.size > state.limits.maxImageBytes) {
            throw new Error(`That photo is ${Math.round(prepared.blob.size / 1048576)} MB; the limit is `
              + `${Math.round(state.limits.maxImageBytes / 1048576)} MB.`)
          }
          setDraft(previous => previous === null ? previous : {
            ...previous,
            busy: 'uploading',
            note: prepared.resized ? STRINGS.resized(state.limits.maxDimension) : '',
          })
          await api('/images', {
            method: 'POST',
            headers: { 'content-type': prepared.type, 'x-background-name': encodeURIComponent(name) },
            body: prepared.blob,
          })
          setDraft(previous => {
            if (previous !== null) URL.revokeObjectURL(previous.preview)
            return null
          })
          setPage(1)
          await load()
        } catch (error) {
          setDraft(previous => previous === null ? previous : { ...previous, busy: false, note: messageOf(error) })
        }
      }, [draft, state.limits])

      const pick = useCallback(id => {
        publish({ activeId: id })
        persistSettings({ activeId: id })
      }, [])

      const renameItem = useCallback(async (id, name) => {
        const trimmed = name.trim()
        if (trimmed === '') return
        setRenaming(null)
        await attempt(async () => {
          await api(`/images/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: trimmed }),
          })
          await load()
        })
      }, [])

      const deleteItem = useCallback(async id => {
        setConfirming(null)
        await attempt(async () => {
          await api(`/images/${encodeURIComponent(id)}`, { method: 'DELETE' })
          await load()
        })
      }, [])

      const removeEveryItem = useCallback(async () => {
        setConfirming(null)
        await attempt(async () => {
          await api('/images', { method: 'DELETE' })
          setPage(1)
          await load()
        })
      }, [])

      const removePreset = useCallback(id => {
        const next = state.presets.filter(preset => preset.id !== id)
        publish({ presets: next })
        persistSettings({ presets: next })
      }, [state.presets])

      const savePreset = useCallback(() => {
        if (savingPreset === null) return
        const name = savingPreset.name.trim()
        if (name === '') return
        // A saved look holds the three alphas and nothing else, so it can be
        // dropped in after any other look without dragging the photo with it.
        const preset = {
          id: newPresetId(state.presets),
          name,
          backgroundOpacity: state.backgroundOpacity,
          elementOpacity: state.elementOpacity,
          sidebarOpacity: state.sidebarOpacity,
        }
        const next = [...state.presets, preset]
        setSavingPreset(null)
        publish({ presets: next })
        persistSettings({ presets: next })
      }, [savingPreset, state])

      const tintReadout = state.tint === 0
        ? STRINGS.tintNone
        : state.tint < 0
          ? STRINGS.tintDarken(Math.round(-state.tint * 100))
          : STRINGS.tintLighten(Math.round(state.tint * 100))

      // Saving the same balance twice is the person's business; the hard limit
      // is not, so only that withholds the control — and it says so in words
      // rather than leaving a disabled button with nothing but a tooltip.
      const presetsFull = state.presets.length >= (state.limits.maxPresets ?? Number.POSITIVE_INFINITY)

      const pageItems = state.items.slice((current - 1) * state.limits.pageSize, current * state.limits.pageSize)

      /** One look in the preset row; a saved one carries its own remove control. */
      const presetChip = (preset, removable) => {
        const active = isPresetActive(state, preset)
        return h('span', {
          key: preset.id,
          className: 'dsh-bgs-presetChip',
          'data-active': active || undefined,
        },
        h('button', {
          type: 'button',
          className: 'dsh-bgs-preset',
          'data-preset': preset.id,
          'aria-pressed': active,
          title: STRINGS.presetTitle(
            Math.round(preset.backgroundOpacity * 100),
            Math.round(preset.elementOpacity * 100),
            Math.round(preset.sidebarOpacity * 100),
          ),
          onClick: () => { applyPreset(preset) },
        }, preset.name),
        removable === true
          ? h('button', {
            type: 'button',
            className: 'dsh-bgs-presetDelete',
            title: STRINGS.presetDeleteNamed(preset.name),
            'aria-label': STRINGS.presetDeleteNamed(preset.name),
            onClick: () => { removePreset(preset.id) },
          }, h(Icon, { name: 'close', size: 11 }))
          : null)
      }

      const tile = item => {
        const isActive = item.id === state.activeId
        if (renaming !== null && renaming.id === item.id) {
          return h('li', { key: item.id, className: 'dsh-bgs-tile' },
            h('div', { className: 'dsh-bgs-tileRename' },
              h('input', {
                ref: renameRef,
                type: 'text',
                className: 'dsh-bgs-input',
                value: renaming.name,
                maxLength: state.limits.maxNameLength,
                'aria-label': STRINGS.renameNamed(item.name),
                onChange: event => { setRenaming({ id: item.id, name: event.target.value }) },
                onKeyDown: event => {
                  if (event.key === 'Enter') void renameItem(item.id, renaming.name)
                  if (event.key === 'Escape') { event.stopPropagation(); setRenaming(null) }
                },
              }),
              h('div', { className: 'dsh-bgs-tileRow' },
                h('button', {
                  type: 'button',
                  className: 'dsh-bgs-small',
                  onClick: () => { void renameItem(item.id, renaming.name) },
                }, STRINGS.save),
                h('button', {
                  type: 'button',
                  className: 'dsh-bgs-small',
                  onClick: () => { setRenaming(null) },
                }, STRINGS.cancel))))
        }
        return h('li', { key: item.id, className: 'dsh-bgs-tile', 'data-active': isActive || undefined },
          h('button', {
            type: 'button',
            className: 'dsh-bgs-thumb',
            'aria-pressed': isActive,
            title: item.name,
            onClick: () => { pick(item.id) },
          },
          h('img', { src: imageUrl(item.id), alt: '', loading: 'lazy', decoding: 'async' }),
          h('span', { className: 'dsh-bgs-thumbName' }, item.name)),
          confirming === item.id
            ? h('div', { className: 'dsh-bgs-tileRow' },
              h('span', { className: 'dsh-bgs-question' }, STRINGS.deleteQuestion),
              h('button', {
                type: 'button',
                className: 'dsh-bgs-small',
                onClick: () => { void deleteItem(item.id) },
              }, STRINGS.yes),
              h('button', {
                type: 'button',
                className: 'dsh-bgs-small',
                onClick: () => { setConfirming(null) },
              }, STRINGS.no))
            : h('div', { className: 'dsh-bgs-tileRow' },
              h('button', {
                type: 'button',
                className: 'dsh-bgs-iconSmall',
                title: STRINGS.renameNamed(item.name),
                'aria-label': STRINGS.renameNamed(item.name),
                onClick: () => { setConfirming(null); setRenaming({ id: item.id, name: item.name }) },
              }, h(Icon, { name: 'pencil', size: 14 })),
              h('button', {
                type: 'button',
                className: 'dsh-bgs-iconSmall',
                title: STRINGS.deleteNamed(item.name),
                'aria-label': STRINGS.deleteNamed(item.name),
                onClick: () => { setRenaming(null); setConfirming(item.id) },
              }, h(Icon, { name: 'trash', size: 14 }))))
      }

      const panel = open && anchor !== null
        ? h('div', {
          className: 'dsh-bgs-panel',
          style: { left: `${anchor.left}px`, bottom: `${anchor.bottom}px`, maxHeight: `${anchor.maxHeight}px` },
          role: 'dialog',
          'aria-label': STRINGS.title,
        },
        h('div', { className: 'dsh-bgs-head' },
          h('span', { className: 'dsh-bgs-title' }, STRINGS.title),
          h('button', {
            type: 'button',
            className: 'dsh-bgs-iconSmall',
            title: STRINGS.close,
            'aria-label': STRINGS.close,
            onClick: () => { setOpen(false) },
          }, h(Icon, { name: 'close', size: 14 }))),
        h('div', { className: 'dsh-bgs-body', ref: bodyRef, tabIndex: -1 },
          state.error === null
            ? null
            : h('div', { className: 'dsh-bgs-alert', role: 'alert' },
              h('span', null, state.error),
              h('button', {
                type: 'button',
                className: 'dsh-bgs-small',
                onClick: () => { void load() },
              }, STRINGS.retry)),
          state.status === 'loading'
            ? h('p', { className: 'dsh-bgs-note' }, STRINGS.loading)
            : null,

          h('section', { className: 'dsh-bgs-section' },
            h('h3', { className: 'dsh-bgs-heading' }, STRINGS.current),
            activeItem === null
              ? h('p', { className: 'dsh-bgs-note' }, STRINGS.noBackground)
              : h('div', null,
                h('div', { className: 'dsh-bgs-preview' },
                  h('img', { src: imageUrl(activeItem.id), alt: '' })),
                h('div', { className: 'dsh-bgs-currentRow' },
                  h('span', { className: 'dsh-bgs-currentName', title: activeItem.name }, activeItem.name),
                  h('button', {
                    type: 'button',
                    className: 'dsh-bgs-small',
                    onClick: () => { pick(null) },
                  }, STRINGS.turnOff)),
                state.backgroundOpacity >= 0.99 && state.elementOpacity >= 0.99
                  && state.sidebarOpacity >= 0.99
                  ? h('p', { className: 'dsh-bgs-note' }, STRINGS.solidHint)
                  : null)),

          h('section', { className: 'dsh-bgs-section' },
            h('h3', { className: 'dsh-bgs-heading' }, STRINGS.addPhoto),
            draft === null
              ? h('div', {
                className: 'dsh-bgs-drop',
                'data-dragging': dragging || undefined,
                onDragOver: event => { event.preventDefault(); setDragging(true) },
                onDragLeave: () => { setDragging(false) },
                onDrop: event => {
                  event.preventDefault()
                  setDragging(false)
                  chooseFile(event.dataTransfer?.files?.[0])
                },
              },
              h(Icon, { name: 'picture', size: 20 }),
              h('span', { className: 'dsh-bgs-dropHint' }, STRINGS.dropHint),
              h('button', {
                type: 'button',
                className: 'dsh-bgs-small',
                onClick: () => { fileRef.current?.click() },
              }, STRINGS.chooseFile))
              : h('div', { className: 'dsh-bgs-draft' },
                h('img', { className: 'dsh-bgs-draftThumb', src: draft.preview, alt: '' }),
                h('label', { className: 'dsh-bgs-field' },
                  h('span', { className: 'dsh-bgs-fieldLabel' }, STRINGS.name),
                  h('input', {
                    ref: draftNameRef,
                    type: 'text',
                    className: 'dsh-bgs-input',
                    value: draft.name,
                    maxLength: state.limits.maxNameLength,
                    disabled: draft.busy,
                    onChange: event => { setDraft({ ...draft, name: event.target.value }) },
                    onKeyDown: event => {
                      if (event.key === 'Enter') void saveDraft()
                      if (event.key === 'Escape') { event.stopPropagation(); closeDraft() }
                    },
                  })),
                h('div', { className: 'dsh-bgs-draftRow' },
                  h('button', {
                    type: 'button',
                    className: 'dsh-bgs-primary',
                    disabled: draft.busy || draft.name.trim() === '',
                    onClick: () => { void saveDraft() },
                  }, draft.busy === 'uploading' ? STRINGS.uploading : draft.busy ? STRINGS.preparing : STRINGS.save),
                  h('button', {
                    type: 'button',
                    className: 'dsh-bgs-small',
                    disabled: draft.busy,
                    onClick: closeDraft,
                  }, STRINGS.cancel)),
                draft.note === '' ? null : h('p', { className: 'dsh-bgs-note' }, draft.note)),
            h('input', {
              ref: fileRef,
              type: 'file',
              accept: 'image/png,image/jpeg,image/webp,image/gif,image/avif',
              className: 'dsh-bgs-file',
              onChange: event => {
                chooseFile(event.target.files?.[0])
                event.target.value = ''
              },
            })),

          // Appearance sits above the library on purpose: the sliders are the
          // controls a photo is tuned with, and a long grid below them would
          // push them off the fold. The alphas run back to front — the ground,
          // the panels over it, then the sidebar that stands beside both —
          // because setting them apart is the whole point of the split.
          h('section', { className: 'dsh-bgs-section' },
            h('h3', { className: 'dsh-bgs-heading' }, STRINGS.appearance),
            // Presets first, because the alphas are easier to start from a known
            // balance — shipped, or one of the person's own — than to search for
            // by dragging three sliders against each other.
            h('div', { className: 'dsh-bgs-presets', role: 'group', 'aria-label': STRINGS.presets },
              h('div', { className: 'dsh-bgs-presetRow' },
                BUILT_IN_PRESETS.map(preset => presetChip(preset)),
                state.presets.map(preset => presetChip(preset, true)),
                savingPreset === null && !presetsFull
                  ? h('button', {
                    type: 'button',
                    className: 'dsh-bgs-preset dsh-bgs-presetAdd',
                    title: STRINGS.presetSaveTitle,
                    onClick: () => { setSavingPreset({ name: suggestedPresetName(state.presets) }) },
                  }, STRINGS.presetSave)
                  : null),
              savingPreset === null
                ? null
                : h('div', { className: 'dsh-bgs-presetForm' },
                  h('input', {
                    ref: presetNameRef,
                    type: 'text',
                    className: 'dsh-bgs-input',
                    value: savingPreset.name,
                    maxLength: state.limits.maxPresetNameLength,
                    'aria-label': STRINGS.presetNameLabel,
                    placeholder: STRINGS.presetSuggest,
                    onChange: event => { setSavingPreset({ name: event.target.value }) },
                    onKeyDown: event => {
                      if (event.key === 'Enter') savePreset()
                      if (event.key === 'Escape') { event.stopPropagation(); setSavingPreset(null) }
                    },
                  }),
                  h('button', {
                    type: 'button',
                    className: 'dsh-bgs-primary',
                    disabled: savingPreset.name.trim() === '',
                    onClick: () => { savePreset() },
                  }, STRINGS.save),
                  h('button', {
                    type: 'button',
                    className: 'dsh-bgs-small',
                    onClick: () => { setSavingPreset(null) },
                  }, STRINGS.cancel)),
              h('p', { className: 'dsh-bgs-hint' }, STRINGS.presetsHint),
              presetsFull
                ? h('p', { className: 'dsh-bgs-hint' }, STRINGS.presetFullHint(state.limits.maxPresets))
                : null),
            h(RangeRow, {
              label: STRINGS.backgroundOpacity,
              hint: STRINGS.backgroundHint,
              min: 0,
              max: 100,
              value: Math.round(state.backgroundOpacity * 100),
              readout: `${Math.round(state.backgroundOpacity * 100)}%`,
              onReset: state.backgroundOpacity === state.defaults.backgroundOpacity ? undefined : () => {
                publish({ backgroundOpacity: state.defaults.backgroundOpacity })
                persistSettings({ backgroundOpacity: state.defaults.backgroundOpacity })
              },
              onChange: next => {
                publish({ backgroundOpacity: next / 100 })
                persistSettings({ backgroundOpacity: next / 100 })
              },
            }),
            h(RangeRow, {
              label: STRINGS.elementOpacity,
              hint: STRINGS.elementHint,
              min: 0,
              max: 100,
              value: Math.round(state.elementOpacity * 100),
              readout: `${Math.round(state.elementOpacity * 100)}%`,
              onReset: state.elementOpacity === state.defaults.elementOpacity ? undefined : () => {
                publish({ elementOpacity: state.defaults.elementOpacity })
                persistSettings({ elementOpacity: state.defaults.elementOpacity })
              },
              onChange: next => {
                publish({ elementOpacity: next / 100 })
                persistSettings({ elementOpacity: next / 100 })
              },
            }),
            h(RangeRow, {
              label: STRINGS.sidebarOpacity,
              hint: STRINGS.sidebarHint,
              min: 0,
              max: 100,
              value: Math.round(state.sidebarOpacity * 100),
              readout: `${Math.round(state.sidebarOpacity * 100)}%`,
              onReset: state.sidebarOpacity === state.defaults.sidebarOpacity ? undefined : () => {
                publish({ sidebarOpacity: state.defaults.sidebarOpacity })
                persistSettings({ sidebarOpacity: state.defaults.sidebarOpacity })
              },
              onChange: next => {
                publish({ sidebarOpacity: next / 100 })
                persistSettings({ sidebarOpacity: next / 100 })
              },
            }),
            h(RangeRow, {
              label: STRINGS.tint,
              min: -100,
              max: 100,
              value: Math.round(state.tint * 100),
              readout: tintReadout,
              onReset: state.tint === state.defaults.tint ? undefined : () => {
                publish({ tint: state.defaults.tint })
                persistSettings({ tint: state.defaults.tint })
              },
              onChange: next => {
                publish({ tint: next / 100 })
                persistSettings({ tint: next / 100 })
              },
            }),
            h(RangeRow, {
              label: STRINGS.blur,
              min: 0,
              max: 24,
              value: state.blur,
              readout: `${state.blur} px`,
              onReset: state.blur === state.defaults.blur ? undefined : () => {
                publish({ blur: state.defaults.blur })
                persistSettings({ blur: state.defaults.blur })
              },
              onChange: next => {
                publish({ blur: next })
                persistSettings({ blur: next })
              },
            })),

          h('section', { className: 'dsh-bgs-section' },
            h('h3', { className: 'dsh-bgs-heading' }, STRINGS.recent),
            state.items.length === 0
              ? h('p', { className: 'dsh-bgs-note' }, STRINGS.empty)
              : h('div', null,
                h('ul', { className: 'dsh-bgs-grid' }, pageItems.map(tile)),
                pageCount <= 1
                  ? null
                  : h('div', { className: 'dsh-bgs-pager' },
                    h('button', {
                      type: 'button',
                      className: 'dsh-bgs-iconSmall',
                      title: STRINGS.previous,
                      'aria-label': STRINGS.previous,
                      disabled: current <= 1,
                      onClick: () => { setPage(Math.max(1, current - 1)) },
                    }, h(Icon, { name: 'left', size: 14 })),
                    h('span', { className: 'dsh-bgs-pageLabel' }, STRINGS.page(current, pageCount)),
                    h('button', {
                      type: 'button',
                      className: 'dsh-bgs-iconSmall',
                      title: STRINGS.next,
                      'aria-label': STRINGS.next,
                      disabled: current >= pageCount,
                      onClick: () => { setPage(Math.min(pageCount, current + 1)) },
                    }, h(Icon, { name: 'right', size: 14 })))))),

        state.items.length === 0
          ? null
          : h('div', { className: 'dsh-bgs-foot' },
            confirming === 'all'
              ? h('div', { className: 'dsh-bgs-tileRow' },
                h('span', { className: 'dsh-bgs-question' }, STRINGS.removeAllQuestion),
                h('button', {
                  type: 'button',
                  className: 'dsh-bgs-small',
                  onClick: () => { void removeEveryItem() },
                }, STRINGS.yes),
                h('button', {
                  type: 'button',
                  className: 'dsh-bgs-small',
                  onClick: () => { setConfirming(null) },
                }, STRINGS.no))
              : h('button', {
                type: 'button',
                className: 'dsh-bgs-small',
                onClick: () => { setConfirming('all') },
              }, STRINGS.removeAll)))
        : null

      return h('div', {
        className: wide ? 'dsh-bgs-layer' : 'dsh-bgs-layer dsh-bgs-layerRail',
        ref: rootRef,
      },
      h('style', null, UI_CSS),
      h('button', {
        type: 'button',
        className: 'dsh-bgs-trigger',
        ref: triggerRef,
        'aria-label': STRINGS.trigger,
        'aria-haspopup': 'dialog',
        'aria-expanded': open,
        title: wide ? undefined : STRINGS.trigger,
        onClick: () => { setOpen(value => !value) },
      },
      h(Icon, { name: 'picture', size: wide ? 16 : 18 }),
      wide ? h('span', { className: 'dsh-bgs-triggerLabel' }, STRINGS.trigger) : null,
      wide ? h('span', { className: 'dsh-bgs-chip' }, activeItem === null ? STRINGS.off : STRINGS.on) : null),
      panel)
    }

    /** Styles for the trigger and the panel; theme tokens only. */
    const UI_CSS = `
.dsh-bgs-layer { position: relative; flex: 1 1 auto; min-width: 0; display: flex; align-items: center; width: 100%; height: 42px; }
.dsh-bgs-layerRail { flex: none; width: 36px; height: 36px; }
.dsh-bgs-trigger { display: inline-flex; align-items: center; gap: 8px; width: 100%; height: 42px; margin: 0; padding: 0 10px 0 8px; border: none; border-radius: 12px; background: transparent; color: var(--dsw-alias-label-primary); font-family: inherit; font-size: 14px; cursor: pointer; overflow: hidden; }
.dsh-bgs-trigger:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent); }
.dsh-bgs-trigger[aria-expanded="true"] { background: color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent); }
.dsh-bgs-layerRail .dsh-bgs-trigger { justify-content: center; gap: 0; width: 36px; height: 36px; padding: 0; border-radius: 50%; }
.dsh-bgs-triggerLabel { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-bgs-chip { flex: none; margin-left: auto; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 16px; }
.dsh-bgs-panel { position: fixed; z-index: 60; width: ${PANEL_WIDTH}px; box-sizing: border-box; display: flex; flex-direction: column; border: 1px solid var(--dsw-alias-border-l1); border-radius: 16px; background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary); box-shadow: 0 18px 48px rgb(0 0 0 / 28%); font-size: 13px; }
.dsh-bgs-head { flex: none; display: flex; align-items: center; gap: 8px; padding: 12px 12px 8px; }
.dsh-bgs-title { flex: 1 1 auto; min-width: 0; font-size: 14px; font-weight: 500; }
.dsh-bgs-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 0 12px 12px; outline: none; }
.dsh-bgs-foot { flex: none; padding: 8px 12px 12px; border-top: 1px solid var(--dsw-alias-border-l1); }
.dsh-bgs-section { padding: 10px 0; border-top: 1px solid var(--dsw-alias-border-l1); }
.dsh-bgs-section:first-of-type { border-top: none; }
.dsh-bgs-heading { margin: 0 0 8px; font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--dsw-alias-label-secondary); }
.dsh-bgs-note { margin: 6px 0 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.dsh-bgs-hint { margin: 6px 0 0; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 1.4; }
.dsh-bgs-alert { display: flex; align-items: flex-start; gap: 8px; margin: 0 0 8px; padding: 8px 10px; border: 1px solid var(--dsw-alias-state-error-primary); border-radius: 10px; color: var(--dsw-alias-label-primary); font-size: 12px; line-height: 1.5; }
.dsh-bgs-alert > span { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.dsh-bgs-preview { position: relative; width: 100%; aspect-ratio: 3 / 1; overflow: hidden; border-radius: 10px; background: var(--dsw-alias-bg-layer-2); }
.dsh-bgs-preview img { width: 100%; height: 100%; object-fit: cover; display: block; }
.dsh-bgs-currentRow { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.dsh-bgs-currentName { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-bgs-drop { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 14px 10px; border: 1px dashed var(--dsw-alias-border-l2); border-radius: 12px; color: var(--dsw-alias-label-secondary); text-align: center; }
.dsh-bgs-drop[data-dragging] { border-color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent); }
.dsh-bgs-dropHint { font-size: 12px; }
.dsh-bgs-draft { display: flex; flex-direction: column; gap: 8px; }
.dsh-bgs-draftThumb { width: 100%; aspect-ratio: 3 / 1; object-fit: cover; border-radius: 10px; background: var(--dsw-alias-bg-layer-2); }
.dsh-bgs-draftRow { display: flex; align-items: center; gap: 8px; }
.dsh-bgs-field { display: flex; flex-direction: column; gap: 4px; }
.dsh-bgs-fieldLabel { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dsh-bgs-input { width: 100%; box-sizing: border-box; padding: 6px 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; }
.dsh-bgs-input:focus-visible, .dsh-bgs-small:focus-visible, .dsh-bgs-primary:focus-visible, .dsh-bgs-iconSmall:focus-visible, .dsh-bgs-thumb:focus-visible, .dsh-bgs-trigger:focus-visible, .dsh-bgs-link:focus-visible, .dsh-bgs-slider:focus-visible, .dsh-bgs-preset:focus-visible, .dsh-bgs-presetDelete:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsh-bgs-presets { margin-bottom: 12px; }
.dsh-bgs-presetRow { display: flex; flex-wrap: wrap; gap: 6px; }
.dsh-bgs-presetChip { display: inline-flex; align-items: center; min-width: 0; overflow: hidden; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; }
.dsh-bgs-presetChip[data-active] { border-color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); }
.dsh-bgs-preset { min-width: 0; padding: 5px 8px; overflow: hidden; border: none; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.dsh-bgs-presetChip .dsh-bgs-preset { border-radius: 0; }
.dsh-bgs-preset:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent); }
.dsh-bgs-preset:disabled { opacity: .5; cursor: default; }
.dsh-bgs-presetAdd { border: 1px dashed var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }
.dsh-bgs-presetAdd:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }
.dsh-bgs-presetDelete { display: inline-flex; align-items: center; justify-content: center; width: 20px; padding: 0; align-self: stretch; border: none; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.dsh-bgs-presetDelete:hover { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); color: var(--dsw-alias-state-error-primary); }
.dsh-bgs-presetForm { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
.dsh-bgs-presetForm .dsh-bgs-input { flex: 1 1 auto; min-width: 0; }
.dsh-bgs-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 0; padding: 0; list-style: none; }
.dsh-bgs-tile { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dsh-bgs-thumb { display: flex; flex-direction: column; gap: 4px; padding: 0; border: none; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.dsh-bgs-thumb img { width: 100%; aspect-ratio: 16 / 9; object-fit: cover; display: block; border-radius: 8px; border: 2px solid transparent; background: var(--dsw-alias-bg-layer-2); }
.dsh-bgs-tile[data-active] .dsh-bgs-thumb img { border-color: var(--dsw-alias-brand-primary); }
.dsh-bgs-thumbName { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dsh-bgs-tile[data-active] .dsh-bgs-thumbName { color: var(--dsw-alias-label-primary); }
.dsh-bgs-tileRow { display: flex; align-items: center; gap: 6px; }
.dsh-bgs-tileRename { display: flex; flex-direction: column; gap: 4px; }
.dsh-bgs-question { flex: 1 1 auto; min-width: 0; font-size: 12px; }
.dsh-bgs-small, .dsh-bgs-primary { padding: 4px 9px; border-radius: 8px; font: inherit; font-size: 12px; cursor: pointer; }
.dsh-bgs-small { border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary); }
.dsh-bgs-small:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent); }
// The fill is solid, so its label must be too: --dsw-alias-bg-base is one of
// the tokens the painter fades, and using it here let the label fade with the
// background slider until Save was unreadable. The inverted label token is the
// theme's own pairing for text on a brand fill, and no slider touches it.
.dsh-bgs-primary { border: 1px solid transparent; background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary-inverted); }
.dsh-bgs-small:disabled, .dsh-bgs-primary:disabled, .dsh-bgs-iconSmall:disabled { opacity: .5; cursor: default; }
.dsh-bgs-iconSmall { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; padding: 0; border: none; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.dsh-bgs-iconSmall:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent); color: var(--dsw-alias-label-primary); }
.dsh-bgs-link { border: none; background: transparent; color: var(--dsw-alias-brand-primary); font: inherit; font-size: 11px; cursor: pointer; padding: 0; }
.dsh-bgs-pager { display: flex; align-items: center; justify-content: center; gap: 8px; margin-top: 8px; }
.dsh-bgs-pageLabel { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dsh-bgs-range { display: flex; flex-direction: column; gap: 6px; }
.dsh-bgs-range + .dsh-bgs-range { margin-top: 12px; }
.dsh-bgs-rangeHead { display: flex; align-items: baseline; gap: 8px; }
.dsh-bgs-rangeLabel { flex: 1 1 auto; min-width: 0; }
.dsh-bgs-rangeValue { font-size: 12px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.dsh-bgs-slider { width: 100%; accent-color: var(--dsw-alias-brand-primary); }
.dsh-bgs-file { display: none; }
`

    /** Register both contributions for the Client run's lifetime. */
    function apply(ctx) {
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'background-swapper-paint',
        order: 0,
        label: 'Background paint',
      }, BackgroundPainter))
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'background-swapper',
        order: 20,
        label: STRINGS.trigger,
      }, SwapBackground))
      void load()
    }

    return { inject: ['slots'], apply }
  },
})
