// UI entry: starts the app. Every feature owns an `initX()` that binds its own
// DOM, in the same order the handlers were originally registered. Cross-feature
// view state lives in ./store.

import { renderCached } from './graph-view';
import { store } from './store';
import { scheduleActivityPoll } from './status-bar';
import { initDetailResizer } from './detail-resizer';
import { initTheme } from './theme';
import { initActions } from './actions';
import { initAiConflict } from './ai-conflict';
import { initCodeViewer } from './code-viewer';
import { initCommitDialog } from './commit-dialog';
import { initConflicts } from './conflicts';
import { initContextMenu } from './context-menu';
import { initDiffView } from './diff-view';
import { initMoreMenu } from './more-menu';
import { initNameDialog } from './name-dialog';
import { initRebase } from './rebase';
import { initRemotes } from './remotes';
import { initReview } from './review-view';
import { initSettings } from './settings';
import { initSearch } from './search';
import { initStatusBar } from './status-bar';
import { initWorktree } from './worktree';
import { initTerminal, restoreTerminals, savedActiveTerminalPath, activateTerminal, applyPanel } from './terminal-view';
import { initPrompt } from './prompt';
import { initCherryPick } from './cherry-pick';
import { refresh } from './actions';
import { api } from './api-client';
import { REVIEW_ACTIVE_KEY, loadMergeRequests, loadReviewSessions, paintReview, persistReviewTabs, readSavedReviewPaths } from './review-view';
import { ReviewTabState, saveActive, terminalForPath } from './store';
import { ACTIVE_KEY, REPOS_KEY, RepoEntry, activateRepo, addRepo, loadTab, readSavedRepos, renderNoRepo, renderTabs } from './tabs';

// UI entry: starts the app. Every feature owns an `initX()` that binds its own
// DOM, in the same order the handlers were originally registered. Cross-feature
// view state lives in ./store.
export function initDialogs(): void {
  // --- Wire up static UI ---

  // The header X closes a dialog by activating the same footer button, so
  // per-dialog cleanup (Monaco disposal, promise resolution) still runs.
  document.querySelectorAll<HTMLButtonElement>('.dialog-close').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      const dlg = btn.closest('dialog');
      dlg?.querySelector<HTMLButtonElement>('menu button[id$="-close"], menu button[id$="-cancel"]')?.click();
    });
  });
}

initMoreMenu();
initDiffView();
initCodeViewer();
initConflicts();
initAiConflict();
initDialogs();
initActions();
initCommitDialog();
initRebase();
initRemotes();
initContextMenu();
initNameDialog();
initWorktree();
initPrompt();
initCherryPick();
initSettings();
initReview();
initTerminal();
initSearch();
initStatusBar();

initTheme();
initDetailResizer();

// Re-layout the graph when the viewport changes so the responsive subject
// column (and the sticky header) stay aligned with the date/hash columns.
let resizeTimer: number | undefined;
window.addEventListener('resize', () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(renderCached, 120);
});

export /**
 * Build initial tabs. Once the client has persisted tab state, that state is
 * authoritative — a closed repository must stay closed across reloads even though
 * the server still has it registered. Only a truly fresh client (no saved key at
 * all) seeds from the server's default repo (LIANA_REPO / Electron launch).
 */
async function bootstrap(): Promise<void> {
  const initialized = localStorage.getItem(REPOS_KEY) !== null;
  const saved = readSavedRepos();
  // Read before registering tabs: addRepo() persists and would overwrite this.
  const savedActive = localStorage.getItem(ACTIVE_KEY);

  let paths = saved;
  if (!initialized) {
    try {
      const { repos } = await api<{ repos: RepoEntry[] }>('/repos', undefined, { scoped: false });
      paths = repos.map((r) => r.path);
    } catch {
      // Server may still be starting (dev-server restart); start with no tabs.
    }
  }
  for (const path of paths) {
    try {
      await addRepo(path, false);
    } catch {
      // Drop paths that no longer resolve to a repository.
    }
  }
  const target = store.tabs.find((t) => t.path === savedActive) ?? store.tabs[0];
  if (target) {
    await activateRepo(target.id);
  } else {
    renderTabs();
    renderNoRepo();
  }

  // Reopen the review tabs that were open before the reload, each bound to its repo.
  let savedReviewPaths = readSavedReviewPaths();
  let savedReviewActive: string | null = null;
  try {
    savedReviewActive = localStorage.getItem(REVIEW_ACTIVE_KEY);
  } catch {
    savedReviewActive = null;
  }
  // Migrate the pre-multi-review key so an existing single review tab survives.
  try {
    const legacy = localStorage.getItem('liana-review-repo');
    if (legacy) {
      if (!savedReviewPaths.includes(legacy)) savedReviewPaths.push(legacy);
      if (!savedReviewActive) savedReviewActive = legacy;
      localStorage.removeItem('liana-review-repo');
    }
  } catch {
    // ignore
  }
  for (const path of savedReviewPaths) {
    const bound = store.tabs.find((t) => t.path === path);
    if (!bound) continue;
    const state: ReviewTabState = {
      repoId: bound.id,
      repoPath: bound.path,
      changes: null,
      job: null,
      poll: undefined,
      saveTimer: undefined,
      edits: new Map(),
      mrs: [],
      mrIid: 0,
      sessions: [],
      showRejected: false,
      sending: new Set(),
    };
    bound.review = state;
    void loadMergeRequests(state);
    void loadReviewSessions(state);
  }
  if (savedReviewActive) {
    const bound = store.tabs.find((t) => t.path === savedReviewActive);
    const state = bound?.review;
    if (bound && state) {
      store.activePanel = { kind: 'review', repoId: bound.id };
      // Review is a per-repo view; make its repository active so it stays bound.
      if (store.activeId !== bound.id) {
        saveActive();
        loadTab(bound);
        void refresh();
      }
      applyPanel();
      paintReview(state);
    }
  }
  persistReviewTabs();

  // Reopen worktree terminals that were open before the reload; a visible one
  // takes precedence over the review view restored above.
  restoreTerminals();
  const savedTerminalActive = savedActiveTerminalPath();
  const terminalState = savedTerminalActive ? terminalForPath(savedTerminalActive) : undefined;
  if (savedTerminalActive && terminalState) {
    // A terminal is bound to a repository; make that repo active before showing it.
    if (store.activeId !== terminalState.repoId) {
      const bound = store.tabs.find((t) => t.id === terminalState.repoId);
      if (bound) {
        saveActive();
        loadTab(bound);
        void refresh();
      }
    }
    await activateTerminal(savedTerminalActive);
  }

  renderTabs();
}

void bootstrap();
scheduleActivityPoll();
