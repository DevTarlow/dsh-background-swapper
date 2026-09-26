# AGENTS.md

This repository is a standalone DeepSeek Harness Web plugin, not part of the
`deepseek-harness` monorepo. It is its own git repository with its own remote
(`DevTarlow/dsh-background-swapper`). `/home/hermes/deepseek-harness/AGENTS.md`
governs the harness source tree; this file governs work here.

## Layout

| Path | Role |
| --- | --- |
| `index.js` | Host half: `apply(ctx, config)` and the `/__background-swapper` route table. |
| `store.js` | Host half: `index.json` and `images/` on disk. |
| `client.js` | Browser half: the overlay painter and the sidebar trigger plus panel. |
| `test/host.test.mjs` | Route surface over real HTTP against a stub Cordis context. |
| `test/client.test.mjs` | Registrations and exact painter CSS against a stub loader. |
| `cordis.patch.yml` | Bundle layer: the loader row and its default configuration. |
| `locale/en.json` | Interface copy. |
| `README.md` | The user-facing contract. Update it with any behavior change. |

Keep the split the README promises: the host half imports only `node:` builtins
and the browser half imports only `react`. That is what lets the plugin load on
a released `dsh` with no build step. Do not add harness package imports.

## Development loop

There is no build step and nothing to compile. The plugin is installed into the
running Web profile through a `link:` dependency in
`~/.dsh/profiles/web/package.json`, so this directory is the live plugin.

- Edit `client.js`, then refresh the browser page.
- Edit `index.js`, `store.js`, or `cordis.patch.yml`, then restart the harness.
- Do not reinstall the plugin or touch the profile wiring to test a change.

## Verification

```sh
npm test                   # both halves, under a second, no browser
node test/host.test.mjs    # host half only
node test/client.test.mjs  # browser half only
```

Run the harness that covers the half you changed; run both when a change crosses
them or touches shared copy. Do not repeat a passing run just because a commit
follows. There is no typecheck, lint, or coverage lane here, and no git hooks are
configured: the two harnesses are the whole gate, and running them is yours to do.

A behavior change updates `README.md` and the owning test in the same commit, the
way the existing history does. Route-surface changes belong in
`test/host.test.mjs`; changes to the panel, the painter CSS, or the slot
registrations belong in `test/client.test.mjs`.

## Commits

After a task is complete, commit it without being asked. Keep one coherent task
per commit and do not bundle unrelated work.

Message style, taken from the existing history:

- Subject: an imperative sentence, capitalized, no type prefix (`feat:`, `fix:`),
  and no trailing period.
- Body: prose saying why the change was needed and what behavior changed, wrapped
  at about 72 columns, ending with a sentence naming the tests updated.

Stage only what the task touched, keep `git diff --cached --check` clean, and end
every file with exactly one newline. Report the commit hash and subject when you
hand back.

## Pushing

Never push on your own. Commit locally, report what is committed, and wait for
the user to say push. When asked, push the current branch to `origin`.

This repository is not a stack and has no CI-gated merge queue, so there is no
`gh stack sync`, rebase, or history-rewrite step. If a push is rejected because
the remote moved, fetch and report instead of forcing.
