# AGENTS.md — Liana

A minimal local git GUI: commit-graph visualization + commit /
rebase / cherry-pick. Vanilla TypeScript + SVG rendered by Vite. The backend is the
transport-agnostic `src/api.ts` (Node, shells out to the `git` CLI), served either
by the Vite dev-server plugin (`dev.ts`) in the browser or by an Electron loopback
server (`electron/server.ts`) in the packaged app.

## Commands

- `npx tsc --noEmit` — type check browser sources (strict; `noUncheckedIndexedAccess` is on)
- `npm run typecheck` — `tsc --noEmit` + `tsc -p tsconfig.electron.json` (Electron sources)
- `npm run build` — type check + production build to `dist/`
- `npm run dev` — browser dev server on :5173 (binds all interfaces)
- `LIANA_REPO=$PWD/test-repo npm run dev` — dev server with a repo pre-loaded
- `npm run electron:dev` — Vite (in-process) + Electron against it
- `npm run electron:build` — build `dist/` + `dist-electron/` (no installer)
- `npm run electron:dist` — the above + electron-builder Linux AppImage/deb in `release/`
- `npm run fixture` — regenerate `./test-repo`, the demo repository
- E2E checks: the API is plain JSON over HTTP — drive it with `curl` against
  `http://localhost:5173/api/*` while `npm run dev` runs. Routes are documented in
  README.md. For visual checks use headless Chromium
  (`chromium --headless=new --screenshot=... http://localhost:5173/`). For the
  packaged app, run the binary under Xvfb and inspect it via `--remote-debugging-port`
  (CDP) — the loopback port is ephemeral and API calls need the `x-liana-token` header.

## Non-negotiables

- **Dependency floor.** The point is a tiny, auditable tool. `lit` and the dev
  toolchain are the floor; don't add nodegit, isomorphic-git, d3, or a UI framework.
  Git access = spawning the `git` CLI, nothing else. The only sanctioned additions
  are the Electron toolchain (`electron`, `electron-builder`, `esbuild`), which exist
  solely to wrap the same UI/backend as a desktop app.
- **`src/git.ts` and `src/api.ts` duplicate git wrappers on purpose.** `src/api.ts`
  is Node-only and is imported by `dev.ts`, `electron/server.ts`, and nothing in the
  browser bundle; the browser must never import it (it would pull Node modules into
  the client). When changing a git command, mirror it in both files and keep the
  types in `src/types.ts` identical on both sides. `npm run build` must not emit any
  `node:` import into `dist/assets/`.
- **Operations are local-only by design.** No clone/fetch/push/pull/remotes UI.
  If a request needs network, it's out of scope — say so instead of adding it.
- **Conflicts surface, never get hidden.** Rebase/cherry-pick failures return
  git's stderr through the API (`{error}`); the UI shows it with `alert()`.
  Don't swallow stderr or invent status codes.
- **Strict TS with `noUncheckedIndexedAccess`.** Index accesses need `?? fallback`
  or `!` when proven safe. `npm run build` must stay clean.
- **`--date-order` is load-bearing.** The layout algorithm (src/layout.ts) assumes
  parents never appear before children in the log. Don't change the git log
  ordering flags without re-checking lane assignment.
- **The dev server auto-restarts when `dev.ts` or `vite.config.ts` change**, and
  an in-flight `/api/state` during that window can fail. Clients should retry
  once after ~1s. When killing the dev server from scripts, kill the process
  group (npm → sh → vite) or the vite child lingers holding :5173.
- **`HEAD` ref detection**: a commit is the branch tip iff its refs include
  `HEAD`; use `state.branches[].isHead` for the checked-out branch. The UI hides
  cherry-pick/rebase buttons when they'd be no-ops (tip of current branch).
- **Multiple repositories are addressed by id.** `createApi` keeps a per-process
  registry of validated repo paths; every repo-scoped `/api` route requires an
  `x-liana-repo: <id>` header (unknown/missing → 400). Only `/api/repos` and
  `/api/open` are unscoped. When adding a route, default it to scoped — resolve the
  path from the registry, never from a global. Both adapters (`dev.ts`,
  `electron/server.ts`) pass the header through to `handle`.
