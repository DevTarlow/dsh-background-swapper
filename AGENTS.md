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

## Releasing

Nothing is published to a registry — `"private": true` is set, and people install
this repository by address — so a release is a version, an annotated tag whose
message is the note, and a GitHub Release written for users.

Bump `"version"` in `package.json`, the one place a version is written. Pre-1.0,
a release that adds or changes behavior moves the minor; a fix-only release moves
the patch. Commit the bump on its own, then tag that commit and publish:

```sh
git tag -a v0.2.0 -F -     # the release note, read from stdin
gh release create v0.2.0 --title v0.2.0 --notes-file notes.md
git push origin main && git push origin v0.2.0
```

`gh release create` is the step that puts it on `/releases` and marks it
**Latest**; pushing the tag alone only fills `/tags`, which is where a release
goes missing without anyone noticing. Write the notes to a scratch file and
delete it afterwards, so no draft copy is committed, and write them in the voice
of `README.md` rather than this file: what changed, what an upgrade does to a
stored `index.json`, the fixes, and the install pin
(`https://github.com/DevTarlow/dsh-background-swapper#v0.2.0`).

A release happens when the user asks for one, never at the end of a task, and
only from a tree whose `npm test` is green — the two harnesses are the whole
gate. When the release touched the host half, the running Harness has to be
restarted before those routes are live; say so when handing back.

The README's screenshots are the one shipped artifact no harness checks: a panel
change leaves them stale, and refreshing them needs eyes on a running Harness.
Take them when that is possible, and say plainly when it is not.
