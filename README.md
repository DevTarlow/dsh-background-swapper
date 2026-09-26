# Background Swapper

A DeepSeek Harness plugin that sets a photo as the harness background.

**Swap Background** sits directly above Settings in the left sidebar. It opens a
panel where you upload a photo, give it a name, and keep a paginated library of
the ones you like. A tint slider darkens or lightens the photo so text stays
readable over it, an element-opacity slider turns the interface itself into
glass, and a blur slider frosts the photo behind it.

## What it does

- **Upload and name** — pick a photo or drop one on the panel, then name it
  before it is saved. The suggested name is the file name.
- **Library with pagination** — every saved photo appears in a grid, newest
  first, six to a page, with the active one ringed. Rename or delete any entry,
  or remove the whole library at once.
- **Tint** — one slider from *Darken 100%* through *None* to *Lighten 100%*,
  applied over the photo.
- **Element opacity** — fades the application's surfaces (frame, sidebar,
  cards, popovers) so the photo shows through them. It starts at 50%, so a
  photo is visible the moment you add one; raise it towards 100% for a more
  solid interface, or lower it to show more of the photo. Menus and dialogs
  never drop below 90% so they stay readable either way.
- **Blur** — 0 to 24 px of frosted glass on the photo.
- **Turn off** — clears the active background and restores the default
  appearance immediately, without deleting anything.

Photos and settings live on the host, so the same library and the same look
appear in every browser and in the desktop app that talks to this harness home.

## Requirements

- DeepSeek Harness with the Web application (the `web` or desktop profile).
  The plugin needs the harness `webServer` service, so a headless profile
  cannot activate it.
- Node 22 or newer, which the harness already requires.

The plugin has **no dependencies**: its host half imports only Node builtins,
and its browser half imports only React, which the Web shell already supplies.

## Install

Clone this repository anywhere:

```sh
git clone https://github.com/DevTarlow/dsh-background-swapper.git
```

Then, in the harness Web UI, open **Plugins** from the left sidebar, choose
**Install**, and paste one of these:

- the absolute path to the clone, for example
  `/path/to/dsh-background-swapper`
- the repository URL itself, `https://github.com/DevTarlow/dsh-background-swapper`
- a published package name, if one exists

Then refresh the page. The same operation from the agent side is
`plugin_manager` with `action: install_bundle` and that path or spec as `target`.

Installed plugins affect every session in that harness profile and survive
restart.

## Use

1. Click **Swap Background** above Settings.
2. Under **Add a photo**, drop an image on the dashed area or press
   **Choose file**. A photo wider or taller than 2560 px is scaled down first
   and the panel says so.
3. Type a name and press **Save**. The photo is stored and becomes the active
   background immediately.
4. Tune **Tint**, **Element opacity**, and **Blur** under **Appearance**, the
   group directly above the library. Slider changes apply as you drag and are
   written to disk once you stop, so the panel never has a Save button.
5. Switch photos by clicking any thumbnail in **Recent**. The preview at the top
   shows the active one; **Turn off** clears it. The pencil button renames an
   entry in place, the trash button asks before deleting it, and **Remove all
   photos** empties the library.

`Escape` or a click outside closes the panel, and focus returns to the button.

## Where your photos are stored

```text
$DSH_HOME/storages/background-swapper/
├── index.json          names, the active photo, and the slider values
└── images/<id>.png     one file per photo
```

`$DSH_HOME` defaults to `~/.dsh`. To move your library to another machine, copy
that whole directory. To start over, delete it — the plugin recreates it on the
next start.

## Configuration

Every value has a default; none is required. They are read from the bundle's
loader row at activation and validated there: an out-of-range or wrongly typed
value fails the plugin loudly instead of being ignored.

| Field | Default | Accepted | Meaning |
| --- | --- | --- | --- |
| `pageSize` | `6` | 1–24 | Photos per page in the library grid. |
| `maxImageBytes` | `16777216` | 65536–67108864 | Largest accepted upload. Enforced on the host, which refuses anything larger with `413` before storing it. |
| `maxDimension` | `2560` | 256–8192 | Longest edge the browser scales a photo down to before upload. |
| `dataDir` | `''` | any path | Library directory. The empty string selects `$DSH_HOME/storages/background-swapper`. A leading `~/` is expanded. |

Change them in [cordis.patch.yml](cordis.patch.yml) and restart the harness. A
profile can also override the row by id in its own patch layer:

```yaml
- id: background-swapper
  config:
    pageSize: 9
    maxImageBytes: 33554432
```

The Plugins page shows no generated settings form for this row, because the
plugin deliberately declares no configuration schema (that is what keeps its
host half free of harness package imports). The YAML above is the settings UI.

## How it works

Two files, plus a storage helper:

| File | Runs | Owns |
| --- | --- | --- |
| [index.js](index.js) | host | `apply(ctx, config)`, and one `prefix` route at `/__background-swapper` for the library, uploads, renames, deletes, and settings. |
| [store.js](store.js) | host | `index.json` plus `images/`: atomic index writes, opaque ids, and `unlink` on delete. |
| [client.js](client.js) | browser | Two slot registrations — the always-mounted painter in `shell.overlay`, and the trigger plus its anchored panel in `sidebar.footer.action`. |

Design choices worth knowing before you change it:

- **The background is painted on `html::before`, not on the app's own DOM.** A
  fixed, oversized pseudo-element at `z-index: -1` carries
  `linear-gradient(<tint>, <tint>), url(...)`, `background-size: cover`, and the
  blur filter.
- **The glass effect redefines theme aliases rather than app styles.** The
  painter's `<style>` element expresses `--dsw-alias-bg-base`,
  `--dsw-specific-sidebar-fill`, `--dsw-alias-bg-layer-1|2|3`, and
  `--dsw-alias-bg-overlay` as `color-mix(in srgb, var(--dsw-static-neutral-bluish-NN) P%, transparent)`,
  using the same palette tone the theme sheet maps each alias from. No app class
  name is targeted, so a rename breaks nothing.
- **Nothing is written outside the React tree.** The painter renders its rules
  as a `<style>` element, so unmounting the plugin restores the interface
  exactly. No `document.body` writes, no stylesheet appended by hand.
- **The browser half imports no harness client package** and hand-writes its own
  controls against `--dsw-alias-*` theme tokens.
- **The host half imports only `node:` builtins**, so it loads on a released
  `dsh` with no workspace resolution or build step.

## Limits and known behavior

- One library per harness home: every browser and desktop window pointed at that
  harness sees the same backgrounds and sliders.
- The opacity number is a preference, not a measured result, because surfaces
  stack: the main column shows the photo through one surface, while the sidebar
  is covered by both the frame and its own column fill, so the sidebar always
  looks a step more solid than the main column at the same setting. At 100% the
  interface is fully opaque and the photo is visible only in the strip the
  columns do not cover, so the panel says so when you leave the slider there.
- `maxImageBytes` is enforced on the host; `maxDimension` is enforced in the
  browser. A client that skips the downscale can still upload anything under the
  byte cap.
- Photos that are scaled down are re-encoded as WebP (falling back to JPEG),
  which drops EXIF metadata. Animated GIFs are never scaled, so they stay
  animated.
- PNG, JPEG, WebP, GIF, and AVIF are accepted. SVG is refused: serving an
  uploaded document from the application's own origin would be a script
  injection surface.
- Interface copy is English and lives in one `STRINGS` object at the top of
  [client.js](client.js), ready for a locale pass.
- Backgrounds are global, not per session or per workspace.

## Uninstall

Open **Plugins**, find **dsh-background-swapper**, and uninstall it. The
interface returns to its default appearance at once. Your photos stay in
`$DSH_HOME/storages/background-swapper`; delete that directory to reclaim the
space.

## Development

```sh
npm test
```

runs both verification harnesses and needs no browser:

- [test/host.test.mjs](test/host.test.mjs) stubs the Cordis context, mounts the
  registered route on a bare `node:http` server, and drives the whole route
  surface over real HTTP — upload, retrieval, rename, settings validation,
  `404`/`405`/`413`/`415` refusals, restart persistence, delete, and clear-all.
- [test/client.test.mjs](test/client.test.mjs) loads the browser bundle against
  a stub module loader and slot registry, asserting both registrations, the
  single `react` request, the library read at activation, and the exact CSS the
  painter emits.

After editing, refresh the page in the browser. A change to the host half needs
a harness restart.

## License

[MIT](LICENSE).
