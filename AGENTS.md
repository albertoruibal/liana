# AGENTS.md — Liana

A minimal GitKraken-style local git GUI: commit-graph visualization + commit /
rebase / cherry-pick. Vanilla TypeScript + SVG rendered by Vite; the "backend" is a
Vite dev-server plugin (`dev.ts`) that shells out to the `git` CLI.

## Commands

- `npx tsc --noEmit` — type check (strict; `noUncheckedIndexedAccess` is on)
- `npm run build` — type check + production build to `dist/`
- `npm run dev` — dev server on :5173 (binds all interfaces)
- `LIANA_REPO=$PWD/test-repo npm run dev` — dev server with a repo pre-loaded
- `npm run fixture` — regenerate `./test-repo`, the demo repository
- E2E checks: the API is plain JSON over HTTP — drive it with `curl` against
  `http://localhost:5173/api/*` while `npm run dev` runs. Routes are documented in
  README.md. For visual checks use headless Chromium
  (`chromium --headless=new --screenshot=... http://localhost:5173/`).

## Non-negotiables

- **No new dependencies.** The whole point is a tiny, auditable tool. `lit` and the
  dev toolchain are the floor; don't add nodegit, isomorphic-git, d3, or a UI
  framework. Git access = spawning the `git` CLI, nothing else.
- **`src/git.ts` and `dev.ts` duplicate git wrappers on purpose.** The browser
  bundle must never import `dev.ts` (it would pull Node modules into the client).
  When changing a git command, mirror it in both files and keep the types in
  `src/types.ts` identical on both sides.
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