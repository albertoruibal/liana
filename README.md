# Liana

A minimal, local-only GitKraken-style git GUI: an interactive commit graph with
**commit**, **rebase**, and **cherry-pick**. No clone, no fetch, no push — this is a
visual history surgeon for repositories that already live on your machine.

## Architecture

```
Browser (lit-free vanilla TS + SVG)
  │  fetch /api/*
  ▼
Vite dev server (dev.ts plugin, Node)
  │  spawn `git …`
  ▼
Your repository (working directory, on-disk refs)
```

- `dev.ts` — Vite plugin that IS the backend: JSON API under `/api/*`, git CLI wrappers.
  Runs only under `vite dev` (the production build is a static bundle).
- `src/git.ts` — browser-side mirror of the same wrappers (typed contract, kept in sync).
- `src/layout.ts` — lane assignment (see below). Pure function, no DOM.
- `src/graph.ts` — SVG renderer: lanes as bezier curves, merge commits as rings,
  branch chips as rounded rects.
- `src/ui.ts` — toolbar, detail pane, dialogs, API calls.

### Lane algorithm (src/layout.ts)

Input: commits in `--date-order` (children never before parents). Each commit claims
the lane previously reserved for it, else the lowest free lane. First-parent edges
continue straight in the child's lane; second-parent edges curve and take a reserved
or new lane. This is what produces the GitKraken look with parallel vertical lanes.

## API

| Route | Method | Body | Effect |
|---|---|---|---|
| `/api/state` | GET | — | Repo state, commits (date-order, first 500), status |
| `/api/open` | POST | `{path}` | Point the server at another local repo |
| `/api/commit` | POST | `{message}` | `git add -A` + `git commit -m` |
| `/api/rebase` | POST | `{onto}` | Rebase current branch onto a branch or commit hash |
| `/api/cherry-pick` | POST | `{ref}` | Cherry-pick a commit hash onto current branch |
| `/api/checkout` | POST | `{branch}` | Checkout a local branch |

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

## Scope: intentionally NOT here

clone / fetch / push / pull / remotes / stashes / submodules / conflict resolution UI.
Operations that would open an editor or conflict mid-rebase return git's error text
in the API response and the UI shows it.