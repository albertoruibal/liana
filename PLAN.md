# Liana — implementation plan for OpenCode

You are implementing features in **Liana** (`/home/agent/workspace/liana`), a minimal
GitKraken-style local git GUI. Read `AGENTS.md` FIRST and obey it — especially:
no new dependencies, strict TS must stay clean (`npx tsc --noEmit`), mirror git
wrapper changes in both `dev.ts` and `src/git.ts`, keep operations local-only.

Read `README.md` for the architecture and API table. Work in small vertical slices:
implement, type-check, E2E-verify over HTTP, then move to the next phase.

Verification recipe for every phase (run while `npm run dev` is up):
1. `npx tsc --noEmit` → clean.
2. `curl -s http://localhost:5173/api/state | python3 -m json.tool | head -40` → shape looks right.
3. Exercise the new route/behavior with curl POSTs; confirm side effects with
   `git -C test-repo log --oneline --graph --all`.
4. Visual changes: `chromium --headless=new --no-sandbox --window-size=1400,900
   --screenshot=/tmp/liana.png --virtual-time-budget=5000 http://localhost:5173/`
   and confirm the pixels actually changed as intended.

## Phase 1 — Selection UX hardening (small, warm-up)

- Highlight the selected commit: selected dot gets a white outline ring;
  clicking empty SVG space clears selection.
- Keyboard: `Escape` clears selection and closes the commit dialog.
- Selected commit persists across Refresh (it already re-renders; just don't lose it).

## Phase 2 — Safety rails before mutations

- Block `/api/commit` and `/api/rebase` when `status.entries` is non-empty for
  rebase (git would refuse anyway — make the API return a 409 with a clear
  message instead of raw git stderr).
- The UI detail pane shows a yellow banner when the working tree is dirty:
  "N uncommitted changes — commit or stash before rebasing".
- After any failed mutation, the UI keeps the graph intact (it already reloads;
  verify the graph doesn't blank out on error).

## Phase 3 — Real staged/unstaged view

- `loadStatus` currently flattens porcelain XY codes. Split `StatusEntry` into
  `stagedX` and `unstagedY` codes; render two lists ("Staged" / "Unstaged") in
  the detail pane.
- Commit dialog: checkbox "stage everything" (default true) vs commit only what's
  staged (`git commit` without `add -A`).

## Phase 4 — Cherry-pick parent selection + drag affordance

- When a merge commit is selected, offer per-parent cherry-pick ("-m 1" / "-m 2").
  Server route: extend `/api/cherry-pick` body with `{ref, mainline}`.
- Add `-x` flag option (record source hash in the message); checkbox in UI.

## Phase 5 — Interactive rebase lite

- New route `/api/rebase-start` with `{onto}` returning the todo list
  (`git rebase -i` equivalent parsed from `git rebase --onto` + `git log`).
- UI: modal listing commits with per-commit action dropdown (pick / drop / reword /
  squash), then execute via `GIT_SEQUENCE_EDITOR` script injection
  (`git -c sequence.editor=...` with a temp todo file). This is the hardest phase —
  do it last, keep it behind a feature flag in `config` until E2E-proven.

## Phase 6 — Polish

- Column widths: measure real text with `getComputedTextLength()` instead of the
  0.58em estimate in `src/graph.ts` (two-pass render or `getBBox` after append).
- Zoom (ctrl+wheel) and pan (drag) on the graph pane.
- Dark/light theme toggle persisted in localStorage.
- Commit detail shows diff stats (`git show --stat`); add `/api/commit-diff`.

## Out of scope (do NOT add)

clone, fetch, push, pull, remote management, stashes, submodules, conflict
resolution UI, GitHub integrations. If a request leads there, stop and report.