/**
 * Structural verification of the browser half without a DOM or a React
 * renderer: load the module, run its factory with a minimal `react` stub, run
 * `apply` against a stub slot registry, and assert both registrations and the
 * one library read it starts. Temporary harness; not shipped.
 */
import assert from 'node:assert/strict'

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
globalThis.fetch = async (url, options) => {
  reads.push({ url, options })
  return {
    ok: true,
    status: 200,
    json: async () => ({
      ok: true, items: [], activeId: null, tint: 0, backgroundOpacity: 1, elementOpacity: 1, blur: 0, limits: {},
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

console.log('client half: all assertions passed')
