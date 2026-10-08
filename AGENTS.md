# AGENTS.md — Liana

A minimal local git GUI: commit-graph visualization + commit / rebase / cherry-pick / revert, integrated conflict
resolution, submodules, and forge-agnostic (GitLab / GitHub) AI code review with AI commit messages. Vanilla TypeScript
plus SVG rendered by Vite. The backend is the transport-agnostic `src/api/` (Node, shells out to the `git` CLI), served
either by the Vite dev-server plugin (`dev.ts`) in the browser or by an Electron loopback server (`electron/server.ts`)
in the packaged app.

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
- `npm run fixture:conflict` — `./test-repo-conflict`: a repo left mid-rebase with a conflict plus a local submodule,
  for exercising conflict resolution
- E2E checks: the API is plain JSON over HTTP — drive it with `curl` against `http://localhost:5173/api/*` while `npm
  run dev` runs. Routes are documented in README.md. For visual checks use headless Chromium (`chromium --headless=new
  --screenshot=... http://localhost:5173/`). For the packaged app, run the binary under Xvfb and inspect it via
  `--remote-debugging-port` (CDP) — the loopback port is fixed (54262, with fallbacks) and API calls need the
  `x-liana-token` header.

## Non-negotiables

- **`src/git/` and `src/api/` duplicate git wrappers on purpose.** Each is split by functionality into the same
  module names (`exec`, `paths`, `repo`, `operations`, `conflicts`, `submodules`, `worktrees`, `diffs`, `rebase`,
  `branches`, `remotes`, `reset`, `stash`); `src/api/index.ts` adds the router and `src/git/forge.ts` mirrors the forge
  routes.
  `src/api/` is Node-only and is imported by `dev.ts`, `electron/server.ts`, and nothing in the browser bundle;
  the browser must never import it (it would pull
  Node modules into the client). When changing a git command, mirror it in the matching modules of both trees and keep
  the types in `src/types.ts` identical on both sides. `npm run build` must not emit any `node:` import into
  `dist/assets/`.
- **Network operations are limited to push / pull / login / submodules, the code-review integrations, the AI conflict
  fix, fetching an MR head for review, and AI commit-message generation.** Clone and remote *management*
  (add/rename/set-url) stay out of scope. Push/pull/login and submodule `init`/`update`/`sync`/`add` are sanctioned; so
  are (a) OpenAI-compatible `/chat/completions` endpoints and (b) the GitLab and GitHub REST APIs used to read
  merge/pull requests and post review comments. Selecting a merge request may additionally run `git fetch --no-tags
  <origin> +refs/merge-requests/<iid>/head:refs/liana/mr/<iid>` (falling back to fetching the head SHA) so the read-only
  review tools can see the commit; this only writes objects and the hidden `refs/liana/mr/<iid>` ref and never moves
  `HEAD`, the index, or the working tree. Git network commands must set `GIT_TERMINAL_PROMPT=0` so git never blocks on a
  terminal prompt; both git and HTTP failures must surface the upstream error text through `{error}` unchanged, and all
  HTTP requests need a timeout (`AbortController`). Git credentials come from git's own credential helper / SSH agent.
  The *only* secrets Liana stores are AI, GitLab, and GitHub tokens, in `~/.config/liana/config.json`
  (`XDG_CONFIG_HOME`, atomic write, mode `0600`); `LIANA_AI_API_KEY` / `LIANA_GITLAB_TOKEN` / `LIANA_GITHUB_TOKEN`
  override them at runtime. The API never echoes a stored secret back to the renderer (masked to `hasKey`). Review
  sessions are the one other thing written to disk (`~/.config/liana/sessions/`, `0600`/`0700`): they hold review
  content, never secrets. If a request needs any other network capability, say so instead of adding it.
- **Strict TS with `noUncheckedIndexedAccess`.** Index accesses need `?? fallback` or `!` when proven safe. `npm run
  build` must stay clean.
- **`--date-order` is load-bearing.** The layout algorithm (src/layout.ts) assumes parents never appear before children
  in the log. Don't change the git log ordering flags without re-checking lane assignment.
- **The dev server auto-restarts when `dev.ts` or `vite.config.ts` change**, and an in-flight `/api/state` during that
  window can fail. Clients should retry once after ~1s. When killing the dev server from scripts, kill the process group
  (npm → sh → vite) or the vite child lingers holding :5173.
- **`HEAD` ref detection**: a commit is the branch tip iff its refs include `HEAD`; use `state.branches[].isHead` for
  the checked-out branch. The UI hides cherry-pick/rebase buttons when they'd be no-ops (tip of current branch).
- **Multiple repositories are addressed by id.** `createApi` keeps a per-process registry of validated repo paths; every
  repo-scoped `/api` route requires an `x-liana-repo: <id>` header (unknown/missing → 400). Only `/api/repos` and
  `/api/open` are unscoped. When adding a route, default it to scoped — resolve the path from the registry, never from a
  global. Both adapters (`dev.ts`, `electron/server.ts`) pass the header through to `handle`.

## Code review, AI, GitLab & GitHub

- Review backends are **Node-only**: `src/settings.ts`, `src/review/` (split into `ai.ts`, `commit-message.ts`,
  `comments.ts`, `jobs.ts`, `delegations.ts` behind `index.ts`), `src/review-tools.ts`, `src/conflict-fix.ts`,
  `src/forge.ts`, `src/forges.ts`, `src/gitlab.ts`, `src/github.ts`, and `src/sessions.ts` are imported only by
  `src/api/`; the browser must never import them (same `node:`-leak rule as `src/api/`). Keep them listed in
  `tsconfig.electron.json`.

- The review feature is forge-agnostic behind `ReviewForge` (`src/forge.ts`). `src/gitlab.ts` and `src/github.ts`
  implement it; `src/forges.ts` holds the registry, origin-based `detectForgeFromRemote`, and `resolveForge` (explicit
  settings preference wins over the `origin` host, which wins over which token is configured; absent all of that,
  GitLab). Adding a forge means adding one module and one `forgeByKind` case — no changes to the agent loop or tools.
- The forge is resolved **per repository** from the registered repo path, never from a global. `/api/forge/*` is the
  neutral surface; `/api/gitlab/*` are deprecated aliases that force GitLab. Mirror every new route in `src/git/` with
  identical types (the same duplication rule as `src/api/`).
- Secrets: the GitLab token *and* the GitHub token live in the same `0600` config, masked to `hasToken`;
  `LIANA_GITLAB_TOKEN` / `LIANA_GITHUB_TOKEN` override them at run time.
- GitHub anchoring: map `newLine`/`oldLine` onto `line`/`side` plus `start_line`/`start_side` for a two-sided range. A
  stale `commit_id` (new pushes) or a non-anchorable line returns 422/404 and must degrade to a plain issue comment,
  never fail the whole post. The head fetch mirrors GitLab: `refs/pull/<n>/head` → `refs/liana/pr/<n>`, with the SHA
  fallback, writing only objects and the hidden ref.
- The LLM harness runs **read-only tools** against the repository, defaulting to the merge request's head SHA (never the
  local working tree). Tools resolve paths inside the repo only, truncate output, and never write to the working tree or
  index. The agent loop is bounded by `maxSteps` and a chars/4 context budget; batching and a one-shot fallback keep
  small local models usable.
- **Reviews are pausable and persistent.** `src/sessions.ts` writes the agent checkpoint (message history, batch cursor,
  negotiated protocol) to `~/.config/liana/sessions/<id>.json` — mode `0600` in a `0700` dir, keyed by absolute repo
  path, ≤12 per repo, `running` sessions reopened as `paused` at startup. Pause aborts the in-flight call but keeps the
  checkpoint; cancel is terminal; resume re-enters the same step. The checkpoint is written *before* each model call so
  a mid-call pause re-issues that step. Session ids are also the `jobId`; `/review/status|cancel|pause|resume|session*`
  must check the job/session's `repoPath` against the request's `x-liana-repo`.
- Protocol support is negotiated per provider: native OpenAI `tools`/`tool_calls` with fallbacks to a text ReAct loop or
  a single-JSON protocol; the choice is remembered per provider after the first successful run.
- GitLab and GitHub are read + review-comment + approve only (list/read MRs and PRs, create discussions / review
  comments, approve). Liana never merges, pushes code, or manages GitLab/GitHub projects. Review comments are posted
  **only after per-comment user approval**.
- Every AI/GitLab/GitHub HTTP call runs in the backend behind the normal `/api` proxy (so dev and Electron share it),
  uses `AbortController` timeouts, and surfaces upstream error bodies unchanged. Secrets live in the 0600 config file or
  env vars and are never returned to the renderer.
- The review UI is a **main view** (`#review-view`), not a dialog, shown in place of the graph/detail columns and
  surfaced as a `#repo-tabs` pill. Each open repository can have **its own review tab**: `reviewTabs: Map<repoId,
  ReviewTabState>` holds the per-repo MR/job/session/edit state, and `activeReviewId` marks which one is visible (`null`
  = graph view). Opening Code review on a repo that already has a tab focuses it (state preserved); switching to another
  repo tab hides the review while its background polling continues (DOM writes are guarded by `activeReviewId ===
  state.repoId`). The tab strip renders each review tab right after its repo tab. All review/forge calls go through
  `reviewApi(state, …)`, scoped to `state.repoId` rather than the active tab, so background status polling survives a
  tab switch. The Saved-review picker defaults to none; choosing a session calls `restoreSession`, which applies both
  its MR (`state.mrIid`, pinned as a "(not open)" option when the request is no longer open) and its job, so a paused
  session shows the resume state. Open review tabs and the active one are persisted in `localStorage`
  (`liana-review-tabs` / `liana-review-active`, migrating the old `liana-review-repo`) so they reopen after a reload.
  Sessions are already keyed by absolute repo path server-side, so no backend change is needed for this.

## Conflict resolution & submodules

- Resolve conflicts **file-level**: the UI shows base / ours / theirs from `git show :1:/:2:/:3:<path>`, offers `git
  checkout --ours|--theirs` plus `git add`, and lets the user **edit the working-tree file directly** in an editor
  seeded with its current (marker-bearing) contents; saving writes that file and stages it with `git add`. Liana never
  invents a merge or touches git's own operation state (`rebase-merge`/`MERGE_HEAD`/…) — only the resolved working-tree
  file is written. The one automated exception is the AI conflict fix below.
- **AI conflict fix** (`src/conflict-fix.ts`, Node-only): a per-file, on-demand proposal. `POST /api/conflict-fix` reads
  the three index stages via `loadConflictFile` and asks the active provider (the same OpenAI-compatible endpoint as
  reviews, through `completeText` in `src/review/ai.ts`) for a merged file; `POST /api/conflict-apply` writes that
  **user-approved** result to the working tree and `git add`s it. `POST /api/conflict-save` is the manual counterpart
  (the editable Result pane), writing the user's edited working-tree file and staging it. These stay file-level: they
  re-check the path is still unmerged, confine it to the repo, and never touch submodule gitlinks or binary files.
  Nothing is written without explicit user approval.
- Merge / rebase / cherry-pick / revert state is always **read from git** (`git rev-parse --git-path` on
  `rebase-merge`/`rebase-apply`/`MERGE_HEAD`/ `CHERRY_PICK_HEAD`/`REVERT_HEAD`), never inferred. Continue / skip / abort
  map 1:1 to git's own `--continue` / `--skip` / `--abort`.
- Conflicts and submodule failures surface git's stderr through the API (`{error}`) unchanged — don't swallow stderr or
  invent status codes.
- Submodule network access (`init`/`update`/`sync`/`add`) uses the same `GIT_TERMINAL_PROMPT=0` environment as push/pull
  and stores no credentials.
- Gitlink (mode 160000) and submodule changes are rendered explicitly ("Subproject commit …"), never as a line diff.
- **Worktrees are managed locally.** `src/api/worktrees.ts` (mirrored in `src/git/`) wraps `git worktree
  add/remove/lock/unlock/move/prune` and the read-only `git worktree list --porcelain`; none touch the network, so no
  `NET_ENV`. Opening a worktree is just `addRepo(path)` — it registers as an ordinary repository. `Remove` deletes the
  working directory and is blocked by uncommitted changes unless `force` is passed; never remove the main or current
  worktree from the UI.
- **No native `window.confirm()` / `window.prompt()`.** Every confirmation goes through `confirmDialog` in
  `src/ui/confirm.ts`, every single-text prompt through `promptText` in `src/ui/prompt.ts` (`tabs.ts` still prefers
  Electron's native folder picker). The cherry-pick options dialog lives in `src/ui/cherry-pick.ts` and reuses the
  existing `/cherry-pick` route — `mainline` is selected only for merge commits, `-x` is a checkbox. Styling reuses the
  shared `dialog` / `.dialog-head` / `dialog menu` / `.btn-danger` classes; destructive actions use `danger: true`.
