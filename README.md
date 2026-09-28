# Liana

A minimal, local-only git GUI: an interactive commit graph with
**commit**, **rebase**, and **cherry-pick**. No clone, no fetch, no push — this is a
visual history surgeon for repositories that already live on your machine.

## Architecture

```
Renderer (lit-free vanilla TS + SVG)          Node
  │  fetch /api/*                              │
  ├── browser dev ──► Vite dev server (dev.ts) │
  └── Electron ─────► electron/server.ts ──────┤
                          (127.0.0.1 loopback)  │
                                                ▼
                                        src/api.ts  ──► spawn `git …`
                                                ▼
                        Your repository (working directory, on-disk refs)
```

The backend is `src/api.ts`: a transport-agnostic, Node-only module holding every
git wrapper and `/api` route behind `createApi(...).handle(route, method, body)`.
Two thin adapters serve it — the Vite plugin for browser dev, and a loopback HTTP
server for the packaged Electron app. The renderer only ever speaks `fetch('/api/*')`.

- `src/api.ts` — Node-only backend: JSON route dispatch + git CLI wrappers.
- `dev.ts` — Vite plugin adapter; runs only under `vite dev`.
- `electron/main.ts` — main process: window, native folder dialog, git-on-PATH.
- `electron/server.ts` — packaged mode: loopback server (UI static files + `/api`).
- `electron/preload.ts` — `contextBridge` surface (`window.liana`).
- `src/git.ts` — browser-side mirror of the same wrappers (typed contract, kept in sync).
- `src/layout.ts` — lane assignment (see below). Pure function, no DOM.
- `src/graph.ts` — SVG renderer: lanes as bezier curves, merge commits as rings,
  branch chips as rounded rects.
- `src/ui.ts` — toolbar, detail pane, dialogs, API calls.

### Lane algorithm (src/layout.ts)

Input: commits in `--date-order` (children never before parents). Each commit claims
the lane previously reserved for it, else the lowest free lane. First-parent edges
continue straight in the child's lane; second-parent edges curve and take a reserved
or new lane. This is what produces the parallel vertical lanes.

## API

| Route | Method | Body | Effect |
|---|---|---|---|
| `/api/state` | GET | — | Repo state, commits (date-order, first 500), status |
| `/api/open` | POST | `{path}` | Point the server at another local repo |
| `/api/commit` | POST | `{message, stageAll?}` | `git commit -m`; stages everything first unless `stageAll` is false |
| `/api/rebase` | POST | `{onto}` | Rebase current branch onto a branch or commit hash (409 if dirty) |
| `/api/rebase-start` | POST | `{onto}` | List commits `onto..HEAD` (oldest first) for an interactive rebase |
| `/api/rebase-execute` | POST | `{onto, items[]}` | Run the generated interactive-rebase todo |
| `/api/cherry-pick` | POST | `{ref, mainline?, record?}` | Cherry-pick a commit; `mainline` = `-m N`, `record` = `-x` (409 if dirty) |
| `/api/commit-diff` | POST | `{hash}` | `git show --stat` text for the commit detail pane |
| `/api/checkout` | POST | `{branch}` | Checkout a local branch |
| `/api/branch-create` | POST | `{name, ref}` | Create `ref` and check out a branch (`git checkout -b`) |
| `/api/branch-delete` | POST | `{name, remote?}` | Delete a branch: local `-D`, or `push --delete` when `remote` |
| `/api/tag-create` | POST | `{name, ref}` | Create a lightweight tag at `ref` |
| `/api/tag-delete` | POST | `{name}` | Delete a tag (`git tag -d`) |
| `/api/reset` | POST | `{mode, ref}` | `git reset --soft\|--mixed\|--hard <ref>` on the checked-out branch |

Mutations that git refuses on a dirty tree (`/api/rebase`, `/api/rebase-execute`,
`/api/cherry-pick`) return HTTP **409** with a human message instead of raw stderr;
failed operations keep the graph intact. Interactive rebase ships behind
`INTERACTIVE_REBASE_ENABLED` in `src/config.ts`.

Right-click a commit to create a branch/tag there or reset the checked-out branch
to it (soft / mixed / hard, confirmed in a dialog); right-click a branch or tag
chip (in the graph or the detail pane) to check it out, or delete it. Deleting a
remote branch runs `git push <remote> --delete`, so it *is* a network operation
even though the rest of the app stays local.

## Run

```bash
npm install
LIANA_REPO=/path/to/repo npm run dev     # open with a repo pre-loaded
# or just `npm run dev` and use "Open repo…" in the UI
```

Create a demo repo to play with:

```bash
npm run fixture                          # creates ./test-repo
LIANA_REPO=$PWD/test-repo npm run dev
```

### Electron desktop app

```bash
npm run electron:dev                     # Vite + Electron, HMR, "Open repo…" picker
LIANA_REPO=$PWD/test-repo npm run electron:dev
npm run electron:dist                    # -> release/Liana-0.1.0.AppImage, liana_0.1.0_amd64.deb
```

In dev the Electron window simply loads `http://localhost:5173`, so the Vite plugin
still serves `/api`. Packaged builds start a loopback server on `127.0.0.1` (ephemeral
port) that serves the built UI and the same API; API requests carry a per-launch
`x-liana-token` header so other local processes cannot drive git, and the server binds
to loopback only. On a GUI launch the app augments `PATH` with common install locations
so it can find `git`.

## Scope: intentionally NOT here

clone / fetch / push / pull / remotes / stashes / submodules / conflict resolution UI.
Operations that would open an editor or conflict mid-rebase return git's error text
in the API response and the UI shows it.