// Git command status bar and recent-commands popover.

import { api } from './api-client';
import { copyToClipboard } from './clipboard';
import { activeTab, store } from './store';
import { $ } from './dom';
import { GitCommandRecord, RepoActivity } from '../types';

// Git command status bar. `store.activity` holds the active tab's last snapshot,
// kept so a stale poll can be dropped.

/** Format a finished command's duration for the status bar meta. */
export function commandMeta(cmd: GitCommandRecord): string {
  const ms = cmd.durationMs ?? 0;
  const time = ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;
  if (cmd.running) return '';
  if (cmd.exitCode === null) return `failed · ${time}`;
  return cmd.exitCode === 0 ? time : `exit ${cmd.exitCode} · ${time}`;
}

/** Paint the status bar from the current `store.activity` snapshot. */
export function renderStatusBar(): void {
  const bar = document.querySelector('#status-bar');
  if (!(bar instanceof HTMLElement)) return;
  const spinner = $('#status-spinner');
  const commandEl = $('#status-command');
  const branchEl = $('#status-branch');
  const metaEl = $('#status-meta');
  const tab = activeTab();

  // Current branch (or detached HEAD) of the active tab, shown left of the command.
  const state = tab?.lastResponse?.state;
  const branch = state
    ? state.detachedHead
      ? 'detached HEAD'
      : state.headBranch ?? ''
    : '';
  branchEl.hidden = !tab || branch === '';
  branchEl.textContent = branch;
  branchEl.title = branch
    ? state?.detachedHead
      ? 'Detached HEAD'
      : `On branch ${branch}`
    : '';

  if (!tab) {
    bar.classList.remove('is-running', 'is-error');
    spinner.hidden = true;
    commandEl.textContent = 'No repository open';
    metaEl.textContent = '';
    return;
  }

  const running = store.activity?.running ?? null;
  const last = store.activity?.last ?? null;
  const shown = running ?? last;
  const failed = !running && last !== null && last.failed;

  bar.classList.toggle('is-running', running !== null);
  bar.classList.toggle('is-error', failed);
  spinner.hidden = running === null;
  commandEl.textContent = shown ? shown.display : 'Ready';
  commandEl.title = shown ? shown.display : '';
  metaEl.textContent = running
    ? 'running…'
    : last
      ? commandMeta(last)
      : '';
}

/** Fetch the active tab's git store.activity and repaint (drops stale cross-tab responses). */
export async function refreshActivity(): Promise<void> {
  const reqId = store.activeId;
  if (!reqId) {
    store.activity = null;
    renderStatusBar();
    return;
  }
  try {
    const next = await api<RepoActivity>('/activity');
    if (store.activeId !== reqId) return;
    store.activity = next;
    renderStatusBar();
    // Keep an open popover live as commands start and finish.
    if (!statusHistory.hidden) renderStatusHistory();
  } catch {
    // Transient (e.g. dev-server restart); keep the previous snapshot.
  }
}

// Poll while anything is running (fast) and idle slowly, so the bar reflects
// external commands too. A command's own API call triggers an immediate refresh.
export const ACTIVITY_RUNNING_MS = 250;

export const ACTIVITY_IDLE_MS = 1500;

export let activityTimer: number | undefined;

export function scheduleActivityPoll(): void {
  window.clearTimeout(activityTimer);
  const delay = store.activity?.active ? ACTIVITY_RUNNING_MS : ACTIVITY_IDLE_MS;
  activityTimer = window.setTimeout(() => {
    void refreshActivity().finally(scheduleActivityPoll);
  }, delay);
}

export const statusHistory = $('#status-history');

export function closeStatusHistory(): void {
  if (statusHistory.hidden) return;
  statusHistory.hidden = true;
  $('#status-command').setAttribute('aria-expanded', 'false');
}

/** Render the recent-commands popover from the current store.activity snapshot. */
export function renderStatusHistory(): void {
  statusHistory.replaceChildren();
  const entries = store.activity?.history ?? [];
  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'status-history-empty';
    empty.textContent = 'No commands yet';
    statusHistory.appendChild(empty);
    return;
  }
  for (const cmd of entries) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `status-history-item${cmd.failed ? ' is-failed' : ''}`;
    btn.title = `Copy: ${cmd.display}`;
    const code = document.createElement('code');
    code.textContent = cmd.display;
    const meta = document.createElement('span');
    meta.className = 'status-history-meta';
    meta.textContent = commandMeta(cmd);
    btn.append(code, meta);
    btn.addEventListener('click', () => {
      closeStatusHistory();
      void copyToClipboard(cmd.display);
    });
    statusHistory.appendChild(btn);
  }
}

/** Toggle the recent-commands popover, anchored above the status bar. */
export function toggleStatusHistory(): void {
  if (!statusHistory.hidden) {
    closeStatusHistory();
    return;
  }
  renderStatusHistory();
  const bar = $('#status-bar').getBoundingClientRect();
  statusHistory.hidden = false;
  $('#status-command').setAttribute('aria-expanded', 'true');
  // Grow upward from the bar's left edge; the popover width is capped by CSS.
  statusHistory.style.bottom = `${window.innerHeight - bar.top + 6}px`;
  statusHistory.style.top = 'auto';
  statusHistory.style.left = `${Math.max(8, bar.left + 10)}px`;
  statusHistory.style.right = 'auto';
}

export function initStatusBar(): void {
  $('#status-command').addEventListener('click', () => toggleStatusHistory());
}
