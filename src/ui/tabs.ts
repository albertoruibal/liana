// Repository tabs: persistence, rendering, and open/activate/close.

import { api } from './api-client';
import { $svg } from './dom';
import { applyTransform, renderAll, renderGraphHeader } from './graph-view';
import { updateSyncButtons } from './remotes';
import { closeReviewTab, paintReview, persistReviewTabs, reviewTabSubtitle, updateReviewVisibility } from './review-view';
import { closeTerminal, activateTerminal, persistTerminalTabs, dismissTerminalView } from './terminal-view';
import { closeStatusHistory, renderStatusBar } from './status-bar';
import { RepoTab, activeTab, saveActive, store } from './store';
import { promptText } from './prompt';
import { toast } from './toast';
import { $ } from './dom';
import { refresh } from './actions';
import { loadReviewSessions } from './review-view';
import { EMPTY_METRICS } from '../graph';

/** Make `tab` active and restore its view state into the globals. */
export function loadTab(tab: RepoTab): void {
  store.activeId = tab.id;
  store.selectedHash = tab.selectedHash;
  store.lastResponse = tab.lastResponse;
  store.remoteStatus = tab.remoteStatus;
  store.panX = tab.panX;
  store.panY = tab.panY;
  store.zoom = tab.zoom;
  store.repoName = tab.name;
  store.currentLayout = null;
  // The cached store.activity belongs to the previously active tab.
  store.activity = null;
  closeStatusHistory();
  applyTransform();
  renderTabs();
  renderStatusBar();
  persistTabs();
}

// --- Repository store.tabs ---

export interface RepoEntry {
  id: string;
  path: string;
  name: string;
}

export const REPOS_KEY = 'liana-repos';

export const ACTIVE_KEY = 'liana-active-repo';

/** Persist the open tab paths and the active tab, in order. */
export function persistTabs(): void {
  try {
    localStorage.setItem(REPOS_KEY, JSON.stringify(store.tabs.map((t) => t.path)));
    const active = activeTab();
    if (active) localStorage.setItem(ACTIVE_KEY, active.path);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {
    // localStorage may be unavailable (private mode); store.tabs still work in-session.
  }
}

export function readSavedRepos(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(REPOS_KEY) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

/** Render the tab strip from `store.tabs`/`store.activeId`. */
export function renderTabs(): void {
  const strip = $('#repo-tabs');
  strip.hidden = store.tabs.length === 0;
  strip.replaceChildren();
  if (store.tabs.length === 0) return;
  for (const tab of store.tabs) {
    const dirty = tab.lastResponse?.status?.entries.length ?? 0;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `repo-tab${tab.id === store.activeId ? ' is-active' : ''}`;
    btn.title = tab.path;
    btn.dataset.repo = tab.id;

    const name = document.createElement('span');
    name.className = 'repo-tab-name';
    name.textContent = tab.name;
    btn.appendChild(name);

    if (dirty > 0) {
      const dot = document.createElement('span');
      dot.className = 'dirty-dot';
      dot.title = `${dirty} uncommitted ${dirty === 1 ? 'change' : 'changes'}`;
      btn.appendChild(dot);
    }

    const close = document.createElement('span');
    close.className = 'repo-tab-close';
    close.textContent = '\u00d7';
    close.title = `Close ${tab.name}`;
    close.setAttribute('role', 'button');
    close.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeTab(tab.id);
    });
    btn.appendChild(close);

    btn.addEventListener('click', () => void activateRepo(tab.id));
    strip.appendChild(btn);

    // A review tab, once opened for this repository, sits right after its repo tab.
    if (store.reviewTabs.has(tab.id)) {
      const review = document.createElement('button');
      review.type = 'button';
      review.className = `repo-tab repo-tab-review${tab.id === store.activeReviewId ? ' is-active' : ''}`;
      review.title = `Code review · ${tab.name}\n${reviewTabSubtitle(store.reviewTabs.get(tab.id))}`;
      review.dataset.review = tab.id;
      review.innerHTML =
        `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2.4h10v11.2H3z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M5.4 5.4h5.2M5.4 8h5.2M5.4 10.6h3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
      const name = document.createElement('span');
      name.className = 'repo-tab-name';
      name.textContent = 'Code review';
      review.appendChild(name);
      const close = document.createElement('span');
      close.className = 'repo-tab-close';
      close.textContent = '\u00d7';
      close.title = `Close ${tab.name} code review`;
      close.setAttribute('role', 'button');
      close.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeReviewTab(tab.id);
      });
      review.appendChild(close);
      review.addEventListener('click', () => activateReviewTab(tab.id));
      strip.appendChild(review);
    }

    // One terminal pill per open worktree shell bound to this repository.
    for (const term of store.terminals.values()) {
      if (term.repoId !== tab.id) continue;
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = `repo-tab repo-tab-terminal${term.path === store.activeTerminalPath ? ' is-active' : ''}`;
      pill.title = `Terminal · ${term.name}\nA shell in the selected worktree.`;
      pill.dataset.terminal = term.path;
      pill.innerHTML =
        `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.6" y="2.6" width="12.8" height="10.8" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M4.4 6.2 6.6 8l-2.2 1.8M8.2 10.4h3.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`;
      const name = document.createElement('span');
      name.className = 'repo-tab-name';
      name.textContent = 'Terminal';
      pill.appendChild(name);
      const close = document.createElement('span');
      close.className = 'repo-tab-close';
      close.textContent = '\u00d7';
      close.title = `Close terminal ${term.name}`;
      close.setAttribute('role', 'button');
      close.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeTerminal(term.path);
        renderTabs();
      });
      pill.appendChild(close);
      pill.addEventListener('click', () => {
        void activateTerminal(term.path).then(() => renderTabs());
      });
      strip.appendChild(pill);
    }
  }

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'repo-tab-new';
  add.textContent = '+';
  add.title = 'Open another repository';
  add.setAttribute('aria-label', 'Open another repository');
  add.addEventListener('click', () => void openRepo());
  strip.appendChild(add);
}

// --- Actions ---

/** Render the empty state shown when no repository is open. */
export function renderNoRepo(): void {
  // No repo means no columns: hide the scroller (and its stale header) entirely.
  $('#graph-scroll').hidden = true;
  $('#graph-empty').hidden = true;
  renderGraphHeader(EMPTY_METRICS);
  const svg = $svg('#graph-svg');
  svg.replaceChildren();
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  const pane = $('#detail-pane');
  pane.innerHTML =
    `<div class="detail-empty">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm11 13.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0ZM4.5 5v6.75c0 .4.1.6.35.85l3.3 3.3c.5.5 1.35.5 1.85 0l.6-.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
      <strong>liana</strong>
      <span class="hint">Open a local git repository to see its commit graph.</span>
      <button class="btn btn-primary" id="empty-open-repo">Open repository…</button>
    </div>`;
  pane.querySelector('#empty-open-repo')?.addEventListener('click', () => void openRepo());
  updateSyncButtons();
  renderStatusBar();
}

/** Open a folder picker and add the chosen repository as a tab. */
export async function openRepo(): Promise<void> {
  // Electron has no window.prompt — use the native folder picker when available,
  // otherwise the styled in-app text prompt.
  const p = window.liana
    ? await window.liana.openRepoDialog()
    : await promptText('Open repository', 'Path to git repository:', '~/workspace/my-repo');
  if (!p) return;
  try {
    await addRepo(p, true);
  } catch (err) {
    toast(String(err));
  }
}

/** Register `path` with the server and add (or focus) its tab. */
export async function addRepo(path: string, activate: boolean): Promise<void> {
  const res = await api<RepoEntry>('/open', { path }, { scoped: false });
  const existing = store.tabs.find((t) => t.path === res.path);
  if (existing) {
    const wasActive = existing.id === store.activeId;
    existing.id = res.id;
    if (wasActive) {
      // The server re-issued this tab's id (e.g. dev-server restart): rebind it.
      store.activeId = res.id;
      await refresh();
    } else if (activate) {
      await activateRepo(res.id);
    } else {
      renderTabs();
      persistTabs();
    }
    return;
  }
  const tab: RepoTab = {
    id: res.id,
    path: res.path,
    name: res.name,
    selectedHash: null,
    lastResponse: null,
    remoteStatus: null,
    panX: 0,
    panY: 0,
    zoom: 1,
  };
  store.tabs.push(tab);
  if (activate) await activateRepo(tab.id);
  else {
    renderTabs();
    persistTabs();
  }
}

/** Switch the active tab: paint the cached view, then refresh so its dirty dot stays accurate. */
export async function activateRepo(id: string): Promise<void> {
  // Selecting a repository always returns to the graph view. Any open review
  // store.tabs keep their state; the one bound to this repo is just hidden.
  if (store.activeReviewId !== null) {
    store.activeReviewId = null;
    updateReviewVisibility();
    renderTabs();
    persistReviewTabs();
  }
  // Terminals keep running in the background; only the view is dismissed.
  if (store.activeTerminalPath !== null) {
    dismissTerminalView();
    persistTerminalTabs();
  }
  if (id === store.activeId) {
    if (store.lastResponse) renderAll(store.lastResponse);
    return;
  }
  const tab = store.tabs.find((t) => t.id === id);
  if (!tab) return;
  saveActive();
  loadTab(tab);
  if (tab.lastResponse) renderAll(tab.lastResponse);
  await refresh();
}

/** Show the review tab for `repoId`, preserving its loaded MR/job state. */
export function activateReviewTab(repoId: string): void {
  const state = store.reviewTabs.get(repoId);
  if (!state) return;
  // The terminal is a competing main view; hide it before showing review.
  if (store.activeTerminalPath !== null) {
    dismissTerminalView();
  }
  // The review is bound to one repository; rebind it as active so subsequent
  // review/GitLab API calls target the same repo the MR belongs to.
  const bound = store.tabs.find((t) => t.id === repoId);
  if (!bound) {
    closeReviewTab(repoId);
    return;
  }
  if (store.activeId !== repoId) {
    saveActive();
    loadTab(bound);
    if (bound.lastResponse) renderAll(bound.lastResponse);
    void refresh();
  }
  store.activeReviewId = repoId;
  updateReviewVisibility();
  paintReview(state);
  renderTabs();
  persistReviewTabs();
  if (!state.job) void loadReviewSessions(state);
}

/** Close a tab; adjacent tab becomes active when the closed one was active. */
export function closeTab(id: string): void {
  const idx = store.tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const wasActive = id === store.activeId;
  store.tabs.splice(idx, 1);
  // Closing a repository closes its review tab and any worktree terminals too.
  if (store.reviewTabs.has(id)) {
    closeReviewTab(id);
  }
  for (const term of [...store.terminals.values()]) {
    if (term.repoId === id) closeTerminal(term.path);
  }
  if (wasActive) {
    const next = store.tabs[idx] ?? store.tabs[idx - 1] ?? store.tabs[store.tabs.length - 1];
    if (next) {
      loadTab(next);
      void refresh();
    } else {
      store.activeId = null;
      store.selectedHash = null;
      store.lastResponse = null;
      store.remoteStatus = null;
      store.repoName = '';
      renderNoRepo();
    }
  }
  updateReviewVisibility();
  renderTabs();
  persistTabs();
  persistReviewTabs();
}
