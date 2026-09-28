/**
 * Structural verification of the browser half without a DOM or a React
 * renderer: load the module, run its factory with a minimal `react` stub, run
 * `apply` against a stub slot registry, and assert both registrations, the one
 * library read it starts, and the exact CSS the painter emits. A second factory
 * run with a stub that hands every hook an initial value then renders the open
 * panel, so its sliders and preset row can be read and driven. Temporary
 * harness; not shipped.
 */
import assert from 'node:assert/strict'
import { DEFAULT_SETTINGS } from '../store.js'

let captured = null
globalThis.window = { __ModuleLoader__: { load: registration => { captured = registration } } }
await import('../client.js')

assert.equal(captured.id, 'dsh-background-swapper')
assert.equal(typeof captured.factory, 'function')

const hooks = {
  state: () => [{
    items: [], activeId: null, backgroundOpacity: 1, elementOpacity: 1, blur: 0, tint: 0,
    limits: {}, error: null, status: 'ready',
  }, () => {}],
}
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (...args) => hooks.state(...args),
  useEffect: () => {},
  useMemo: factory => factory(),
  useRef: () => ({ current: null }),
  useCallback: fn => fn,
}

const requested = []
const plugin = captured.factory(specifier => {
  requested.push(specifier)
  if (specifier === 'react') return React
  throw new Error(`unexpected module request: ${specifier}`)
})
assert.deepEqual(requested, ['react'], 'the client half must request react and nothing else')
assert.deepEqual(plugin.inject, ['slots'])
assert.equal(typeof plugin.apply, 'function')

const reads = []
/** The appearance half of a `GET /list`, taken from the shipped defaults. */
const shipped = {
  tint: DEFAULT_SETTINGS.tint,
  backgroundOpacity: DEFAULT_SETTINGS.backgroundOpacity,
  elementOpacity: DEFAULT_SETTINGS.elementOpacity,
  blur: DEFAULT_SETTINGS.blur,
}
globalThis.fetch = async (url, options) => {
  reads.push({ url, options })
  return {
    ok: true,
    status: 200,
    json: async () => ({
      ok: true, items: [], activeId: null, ...shipped, defaults: { ...shipped }, limits: { pageSize: 6 },
    }),
    text: async () => '',
  }
}

const injected = []
const registered = []
const disposers = []
const ctx = {
  slots: {
    inject(key, callback) {
      injected.push(key)
      disposers.push(callback())
      return () => {}
    },
    register(options, component) {
      registered.push({ options, component })
      return () => {}
    },
  },
}

plugin.apply(ctx)
await new Promise(resolve => { setTimeout(resolve, 0) })

assert.deepEqual(injected, ['shell.overlay', 'sidebar.footer.action'])
assert.equal(registered.length, 2)
assert.deepEqual(registered[0].options, {
  name: 'shell.overlay', id: 'background-swapper-paint', order: 0, label: 'Background paint',
})
assert.deepEqual(registered[1].options, {
  name: 'sidebar.footer.action', id: 'background-swapper', order: 20, label: 'Swap Background',
})
assert.equal(typeof registered[0].component, 'function')
assert.equal(typeof registered[1].component, 'function')
assert.equal(disposers.length, 2)

assert.equal(reads.length, 1)
assert.equal(reads[0].url, '/__background-swapper/list')

// The painter renders nothing until a background is active; a stubbed hook
// surface lets one call observe that without emulating React.
let painterValue = 'unset'
painterValue = registered[0].component({})
assert.equal(painterValue, null, 'no active background must paint no style element')

// One snapshot with an active background, so each painted assertion reads a
// whole set of slider values.
const stateWith = (backgroundOpacity, elementOpacity, extra) => [{
  items: [{ id: 'abc', name: 'Test' }], activeId: 'abc', backgroundOpacity, elementOpacity, blur: 0, tint: 0,
  limits: {}, error: null, status: 'ready', ...extra,
}, () => {}]

hooks.state = () => stateWith(0.5, 0.5, { blur: 8, tint: -0.4 })
const painted = registered[0].component({})
assert.equal(painted.type, 'style')
const css = painted.children[0]
assert.match(css, /html::before \{/)
assert.match(css, /url\("\/__background-swapper\/images\/abc"\)/)
assert.match(css, /filter: blur\(8px\)/)
assert.match(css, /rgba\(0, 0, 0, 0\.340\)/)
assert.match(css, /body \{ --dsw-alias-bg-base: color-mix\(in srgb, var\(--dsw-static-neutral-bluish-00\) 50%, transparent\);/)
assert.match(css, /--dsw-specific-sidebar-fill: color-mix\(in srgb, var\(--dsw-static-neutral-bluish-50\) 50%, transparent\);/)
assert.match(css, /--dsw-alias-bg-overlay: color-mix\(in srgb, var\(--dsw-static-neutral-bluish-150\) 90%, transparent\);/)
assert.match(css, /body\[data-ds-dark-theme\] \{ --dsw-alias-bg-base: color-mix\(in srgb, var\(--dsw-static-neutral-bluish-950\) 50%, transparent\);/)
assert.match(css, /--dsw-specific-sidebar-fill: color-mix\(in srgb, var\(--dsw-static-neutral-bluish-900\) 50%, transparent\);/)

// The two sliders fade different layers, which is the whole point: the
// background alpha moves the ground alone, the element alpha the panels, cards
// and menus raised over it, so a bare ground can sit under solid panels.
hooks.state = () => stateWith(0.25, 0.75)
const split = registered[0].component({}).children[0]
assert.match(split, /--dsw-alias-bg-base: color-mix\(in srgb, var\(--dsw-static-neutral-bluish-00\) 25%, transparent\);/)
assert.match(split, /--dsw-specific-sidebar-fill: color-mix\(in srgb, var\(--dsw-static-neutral-bluish-50\) 75%, transparent\);/)
assert.match(split, /--dsw-alias-bg-layer-3: color-mix\(in srgb, var\(--dsw-static-neutral-bluish-800\) 75%, transparent\);/)
// A menu or dialog keeps its own floor; the floor is per token, not a cap on
// the group, so raising element opacity past it still raises the overlay.
assert.match(split, /--dsw-alias-bg-overlay: color-mix\(in srgb, var\(--dsw-static-neutral-bluish-150\) 90%, transparent\);/)

// The ends of both sliders: 100% restores the stock opaque surfaces (which is
// why a fresh library must not start there), and 0% leaves the photo bare in
// that layer while the other layer is untouched.
hooks.state = () => stateWith(1, 1)
const opaque = registered[0].component({}).children[0]
assert.match(opaque, /--dsw-alias-bg-base: color-mix\(in srgb, var\(--dsw-static-neutral-bluish-00\) 100%, transparent\);/)
// The overlay floor is a minimum, not a cap, so 100% stays the stock value.
assert.match(opaque, /--dsw-alias-bg-overlay: color-mix\(in srgb, var\(--dsw-static-neutral-bluish-150\) 100%, transparent\);/)
assert.doesNotMatch(opaque, /rgba\(0, 0, 0,/)

hooks.state = () => stateWith(0, 0)
const bare = registered[0].component({}).children[0]
assert.match(bare, /--dsw-alias-bg-base: color-mix\(in srgb, var\(--dsw-static-neutral-bluish-00\) 0%, transparent\);/)
assert.match(bare, /--dsw-alias-bg-overlay: color-mix\(in srgb, var\(--dsw-static-neutral-bluish-150\) 90%, transparent\);/)

// A tint at the ends of its range: full dark and full light, never opaque.
hooks.state = () => stateWith(0.5, 0.5, { tint: -1 })
assert.match(registered[0].component({}).children[0], /rgba\(0, 0, 0, 0\.850\)/)
hooks.state = () => stateWith(0.5, 0.5, { tint: 1 })
assert.match(registered[0].component({}).children[0], /rgba\(255, 255, 255, 0\.850\)/)

// ── the panel ───────────────────────────────────────────────────────────────
// The painter harness above never renders SwapBackground: it reads fabricated
// snapshots. Run the factory a second time against a stub that hands every hook
// its own initial value and reports the panel as open and already placed, so the
// button tree can be walked and driven without a DOM. The hook order inside the
// component is snapshot, open, anchor, which is what the counter targets.
let hookCall = 0
const PanelReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: initial => {
    hookCall += 1
    if (hookCall === 2) return [true, () => {}]
    if (hookCall === 3) return [{ left: 8, bottom: 8, maxHeight: 640 }, () => {}]
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect: () => {},
  useMemo: factory => factory(),
  useRef: () => ({ current: null }),
  useCallback: fn => fn,
}

const panelPlugin = captured.factory(specifier => {
  if (specifier === 'react') return PanelReact
  throw new Error(`unexpected module request: ${specifier}`)
})
const panelRegistered = []
panelPlugin.apply({
  slots: {
    inject: (key, callback) => { callback() },
    register: (options, component) => { panelRegistered.push({ options, component }); return () => {} },
  },
})
await new Promise(resolve => { setTimeout(resolve, 0) })

/** Render the open panel against the live snapshot. */
const renderPanel = () => { hookCall = 0; return panelRegistered[1].component({ wide: true }) }

/** Every element in a rendered tree matching one predicate. */
function findAll(node, predicate, found = []) {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, found)
    return found
  }
  if (node === null || typeof node !== 'object') return found
  if (predicate(node)) found.push(node)
  for (const child of node.children ?? []) findAll(child, predicate, found)
  return found
}

const presetButtons = () => findAll(
  renderPanel(),
  node => node.type === 'button' && node.props?.['data-preset'] !== undefined,
)
// A slider row is a component element the stub never expands, so its value is
// read from the props the panel handed it rather than from a rendered input.
const sliderProps = label => findAll(renderPanel(), node => node.props?.label === label)[0]?.props

let buttons = presetButtons()
assert.deepEqual(buttons.map(button => button.children[0]), ['Wallpaper', 'Glass', 'Solid'])
assert.match(buttons[1].props.title, /Background 5%, Elements 50%/)
// The panel's Wallpaper preset repeats the shipped defaults, so a fresh library
// — and a Reset — opens with that balance already lit.
assert.equal(buttons[0].props['aria-pressed'], true)
assert.equal(buttons[1].props['aria-pressed'], false)
assert.equal(sliderProps('Background opacity').value, Math.round(DEFAULT_SETTINGS.backgroundOpacity * 100))
assert.equal(sliderProps('Element opacity').value, Math.round(DEFAULT_SETTINGS.elementOpacity * 100))

// One click moves both alphas in one write and leaves the photo controls where
// they were. The write is debounced, so run its timer at once rather than
// waiting the delay out.
const realSetTimeout = globalThis.setTimeout
let flushPersist = null
globalThis.setTimeout = (fn, _delay, ...args) => { flushPersist = () => { fn(...args) }; return 0 }
buttons[1].props.onClick()
globalThis.setTimeout = realSetTimeout
flushPersist()
await new Promise(resolve => { realSetTimeout(resolve, 0) })

const written = reads.find(read => read.url === '/__background-swapper/state')
assert.deepEqual(JSON.parse(written.options.body), { backgroundOpacity: 0.05, elementOpacity: 0.5 })
buttons = presetButtons()
assert.equal(buttons[1].props['aria-pressed'], true)
assert.equal(sliderProps('Background opacity').value, 5)
assert.equal(sliderProps('Element opacity').value, 50)
assert.equal(sliderProps('Tint').value, Math.round(DEFAULT_SETTINGS.tint * 100))
assert.equal(sliderProps('Blur').value, DEFAULT_SETTINGS.blur)

console.log('client half: all assertions passed')
