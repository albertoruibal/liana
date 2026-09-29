# Liana

A minimal git GUI: an interactive commit graph with
**commit**, **rebase**, and **cherry-pick**, plus **push**, **pull**, and
**login** for repositories that already live on your machine. Clone, fetch, and
remote management are deliberately absent — this is a visual history surgeon, not
a forge client.

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

- `src/api.ts` — Node-only backend: JSON route dispatch + git CLI wrappers. Holds a
  registry of validated repositories addressed by opaque `x-liana-repo` ids.
- `dev.ts` — Vite plugin adapter; runs only under `vite dev`.
- `electron/main.ts` — main process: window, native folder dialog, git-on-PATH.
- `electron/server.ts` — packaged mode: loopback server (UI static files + `/api`).
- `electron/preload.ts` — `contextBridge` surface (`window.liana`).
- `src/git.ts` — browser-side mirror of the same wrappers (typed contract, kept in sync).
- `src/layout.ts` — lane assignment (see below). Pure function, no DOM.
- `src/graph.ts` — SVG renderer: lanes as bezier curves, merge commits as rings,
  branch chips as rounded rects.
- `src/ui.ts` — toolbar, repository tabs, detail pane, dialogs, API calls.

### Lane algorithm (src/layout.ts)

Input: commits in `--date-order` (children never before parents). Each commit claims
the lane previously reserved for it, else the lowest free lane. First-parent edges
continue straight in the child's lane; second-parent edges curve and take a reserved
or new lane. This is what produces the parallel vertical lanes.

## API

Multiple repositories can be open at once, one per UI tab. Every repo-scoped route
requires an `x-liana-repo: <id>` header naming a repository from `GET /api/repos` or
`POST /api/open`; a missing or unknown id returns `400 {error:"Unknown repository"}`.
The client sends the active tab's id on every request. Routes without the header are
`/api/repos` and `/api/open` (repo management).

| Route | Method | Body | Effect |
|---|---|---|---|
| `/api/repos` | GET | — | Repositories known to the server: `[{id, path, name}]` |
| `/api/open` | POST | `{path}` | Validate a local repo and register it (idempotent); returns `{id, path, name}` |
| `/api/state` | GET | — | Repo state, commits (date-order, first 500), status |
| `/api/activity` | GET | — | Git commands for this repo: `{running, last, active, history}` (running command, most recent user action, and the last 10 user commands) |
| `/api/commit` | POST | `{message, files[]}` | `git commit` of the listed paths; stages selected files and unstages already-staged files that aren't listed |
| `/api/rebase` | POST | `{onto}` | Rebase current branch onto a branch or commit hash (409 if dirty) |
| `/api/merge` | POST | `{ref}` | Merge a branch or commit into the checked-out branch (`git merge --no-edit`, 409 if dirty) |
| `/api/rebase-start` | POST | `{onto}` | List commits `onto..HEAD` (oldest first) for an interactive rebase |
| `/api/rebase-execute` | POST | `{onto, items[]}` | Run the generated interactive-rebase todo |
| `/api/cherry-pick` | POST | `{ref, mainline?, record?}` | Cherry-pick a commit; `mainline` = `-m N`, `record` = `-x` (409 if dirty) |
| `/api/commit-diff` | POST | `{hash}` | `git show --stat` text for the commit detail pane |
| `/api/checkout` | POST | `{branch, remote?}` | Checkout a local branch; with `remote:true`, `branch` is a remote-tracking ref (`origin/feature`) and a local tracking branch is created/reused |
| `/api/branch-create` | POST | `{name, ref}` | Create `ref` and check out a branch (`git checkout -b`) |
| `/api/branch-delete` | POST | `{name, remote?}` | Delete a branch: local `-D`, or `push --delete` when `remote` |
| `/api/tag-create` | POST | `{name, ref}` | Create a lightweight tag at `ref` |
| `/api/tag-delete` | POST | `{name}` | Delete a tag (`git tag -d`) |
| `/api/reset` | POST | `{mode, ref}` | `git reset --soft\|--mixed\|--hard <ref>` on the checked-out branch |
| `/api/stash` | POST | `{message?, includeUntracked?}` | `git stash push` (`-u` when `includeUntracked`); `{stashed:false}` when clean |
| `/api/stash-apply` | POST | `{hash}` | `git stash apply` the stash identified by its WIP commit hash (keeps the entry) |
| `/api/stash-drop` | POST | `{hash}` | `git stash drop` the stash identified by its WIP commit hash |
| `/api/remote-status` | GET | — | Current branch, remotes, upstream, ahead/behind counts, credential helper |
| `/api/push` | POST | `{remote?, branch?, force?}` | Push the current branch; sets upstream with `-u` when it has none. `force` adds `--force-with-lease`. 400 without a remote |
| `/api/pull` | POST | `{remote?, branch?}` | `git pull` (merge); proceeds with local changes, git's error surfaced if they'd be overwritten |
| `/api/remote-test` | POST | `{remote}` | `git ls-remote` the remote to test connectivity/auth |

Mutations that git refuses on a dirty tree (`/api/rebase`, `/api/rebase-execute`,
`/api/cherry-pick`, `/api/merge`) return HTTP **409** with a human message instead
of raw stderr; failed operations keep the graph intact. Pull is the exception: local
changes are allowed through and git's own error is surfaced if they'd be
overwritten. Interactive rebase ships behind `INTERACTIVE_REBASE_ENABLED` in
`src/config.ts`.

The toolbar's **Pull** and **Push** buttons sync the checked-out branch: push sets
the upstream (`git push -u`) the first time, pull merges with `git pull`. If a push
is rejected as non-fast-forward the UI offers a `--force-with-lease` retry, and
shift-clicking **Push** forces directly. **Login** opens a dialog showing the
configured remotes and credential helper; it can test a remote with `git ls-remote`.
Credentials are never stored by Liana — they come from
git's own credential helper or SSH agent, and git runs with `GIT_TERMINAL_PROMPT=0`
so a missing credential fails fast with git's error instead of hanging.

Right-click a commit to create a branch/tag there, cherry-pick it onto the
checked-out branch (with an optional `-x` to record the source hash, and `-m N`
for a merge commit's parent), or reset the checked-out branch to it (soft / mixed
/ hard, confirmed in a dialog); right-click a branch or tag chip (in the graph or
the detail pane) to check it out, merge or rebase the checked-out branch onto it,
or delete it. Checking out
a remote-tracking ref creates or reuses the matching local branch tracking it — no
fetch, purely local. Deleting a remote branch runs `git push <remote> --delete`.

The toolbar's **Search** button (or `/`) opens a find panel that filters commits,
branches, and tags case-insensitively. Every whitespace-separated token must match
somewhere (AND) across subject, author, hash, and ref names (local/remote branch,
tag, stash). Matching rows are tinted in the graph, the focused result gets a
stronger highlight, and Enter / Shift+Enter (or the arrows) step through matches.

Select a commit to list its changed files; click a file to open its diff in a
dialog with line-number gutters and add/delete row shading. A **Unified / Split**
toggle switches between a single-column and a side-by-side layout, and the choice
is remembered in `localStorage`. Diffs are read from the commit via
`git show --first-parent`, so merge commits show the changes they introduce
against their mainline parent.

A slim status bar along the bottom shows the `git` command currently executing for
the active tab (with a spinner) and, when idle, the most recently finished command
with its duration or exit code. The backend records every spawned command per
repository, so even commands that don't back a UI action (background state loads)
appear there; the UI polls `/api/activity` (fast while something runs, slowly when
idle). Idle, the bar prefers the last user-initiated command (push, commit, rebase,
checkout, stash, reset, …) over the background reads a refresh triggers, so a push
isn't buried by the `git show` that follows it. Clicking the bar opens a popover of
the last 10 user-initiated commands (failed ones in red); clicking an entry copies
its command line.

## Run

```bash
npm install
LIANA_REPO=/path/to/repo npm run dev     # open with a repo pre-loaded
# or just `npm run dev` and use "Open repo…" in the UI
```

Open several repositories at once with the **+** tab or **Open repo**; each repo gets
its own tab and keeps its own graph view/selection. Open tabs are remembered in
`localStorage` and restored on the next launch (alongside the `LIANA_REPO` default).
Closing a tab never touches the working tree.

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
still serves `/api`. Packaged builds start a loopback server on `127.0.0.1` with a
fixed preferred port (54262, falling back to nearby ports or an ephemeral one when
taken) that serves the built UI and the same API. The stable origin is what lets
the UI's localStorage — open repository tabs, theme, layout prefs — survive app
restarts. API requests carry a per-launch `x-liana-token` header so other local
processes cannot drive git, and the server binds
to loopback only. On a GUI launch the app augments `PATH` with common install locations
so it can find `git`.

## Scope: intentionally NOT here

clone / fetch / remote management / submodules / conflict resolution UI.
Push, pull, and login are the only network operations. Operations that would open
an editor or conflict mid-rebase return git's error text in the API response and
the UI shows it.

Stash entries appear as synthetic nodes in the graph (one per `git stash list`
entry, hanging off the commit they were created on) labeled `stash@{n}`. The
toolbar's **Stash** button saves the current changes (`-u` optional), and a
selected stash can be applied, applied-and-dropped (pop), or dropped from the
detail pane or its right-click menu. `git stash apply` keeps the entry; it is
only removed on an explicit pop/drop.