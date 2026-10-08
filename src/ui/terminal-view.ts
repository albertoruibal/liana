// Terminal main view: registers terminals, toggles visibility, and owns the
// tab-strip pill. Mirrors review-view's shape (one terminal per worktree) but
// keeps the xterm/PTY lifecycle in ./terminal.

import { renderCached } from './graph-view';
import { store } from './store';
import { toast } from './toast';
import { $ } from './dom';
import {
  createTerminalState,
  disposeTerminal,
  ensureTerminalSession,
  focusTerminal,
  terminalAvailable,
} from './terminal';

export const TERMINAL_TABS_KEY = 'liana-terminal-tabs';
const TERMINAL_ACTIVE_KEY = 'liana-terminal-active';

/** Persisted terminal tabs: the worktree path plus the repo used to authorize it. */
interface SavedTerminal {
  path: string;
  repoPath: string;
}

/** Show the terminal view for `path` and make sure its shell is running. */
async function showTerminal(path: string): Promise<void> {
  store.activeTerminalPath = path;
  // A terminal and the code-review view are mutually exclusive main views.
  store.activeReviewId = null;
  updateTerminalVisibility();
  await ensureTerminalSession(path);
  focusTerminal(path);
  persistTerminalTabs();
}

/** Open (or focus) a terminal for a worktree path in the active repository. */
export async function openTerminalTab(path: string): Promise<void> {
  if (!terminalAvailable()) {
    toast('The embedded terminal is only available in the Liana desktop app.', 'info');
    return;
  }
  const tab = store.tabs.find((t) => t.id === store.activeId);
  if (!tab) {
    toast('Open a repository first.', 'info');
    return;
  }
  createTerminalState(path, tab.id, tab.path);
  await showTerminal(path);
}

/** Focus a terminal that is already open, preserving its session. */
export async function activateTerminal(path: string): Promise<void> {
  if (!store.terminals.has(path)) return;
  await showTerminal(path);
}

/** Close a terminal: dispose its session and fall back to the graph if visible. */
export function closeTerminal(path: string): void {
  disposeTerminal(path);
  store.terminals.delete(path);
  if (store.activeTerminalPath === path) {
    store.activeTerminalPath = null;
    updateTerminalVisibility();
    renderCached();
  }
  persistTerminalTabs();
}

/** Keep `#terminal-view` and the graph columns in step with the active terminal. */
export function updateTerminalVisibility(): void {
  const path = store.activeTerminalPath;
  const shown = path !== null && store.terminals.has(path);
  $('#terminal-view').hidden = !shown;
  if (shown && path) {
    const state = store.terminals.get(path);
    $('#terminal-cwd').textContent = state ? ` · ${state.name}` : '';
    // Never show the terminal and the review view at once.
    $('#review-view').hidden = true;
  }
  $('#graph-wrap').hidden = shown;
  $('#detail-resizer').hidden = shown;
  $('#detail-pane').hidden = shown;
}

/**
 * Dismiss the visible terminal (its shell keeps running) and bring the graph
 * columns back. Used when another view takes over.
 */
export function dismissTerminalView(): void {
  store.activeTerminalPath = null;
  updateTerminalVisibility();
}

export function persistTerminalTabs(): void {
  try {
    const saved: SavedTerminal[] = [...store.terminals.values()].map((s) => ({
      path: s.path,
      repoPath: s.repoPath,
    }));
    localStorage.setItem(TERMINAL_TABS_KEY, JSON.stringify(saved));
    if (store.activeTerminalPath) {
      localStorage.setItem(TERMINAL_ACTIVE_KEY, store.activeTerminalPath);
    } else {
      localStorage.removeItem(TERMINAL_ACTIVE_KEY);
    }
  } catch {
    // localStorage may be unavailable (private mode); terminals still work in-session.
  }
}

export function readSavedTerminals(): SavedTerminal[] {
  try {
    const raw = JSON.parse(localStorage.getItem(TERMINAL_TABS_KEY) ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (e): e is SavedTerminal =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as SavedTerminal).path === 'string' &&
        typeof (e as SavedTerminal).repoPath === 'string',
    );
  } catch {
    return [];
  }
}

/** The worktree path of the terminal that was visible before the reload. */
export function savedActiveTerminalPath(): string | null {
  try {
    return localStorage.getItem(TERMINAL_ACTIVE_KEY);
  } catch {
    return null;
  }
}

/**
 * Re-register terminals that were open before a reload (without starting their
 * shells); `bootstrap` activates the visible one afterwards.
 */
export function restoreTerminals(): void {
  if (!terminalAvailable()) return;
  for (const entry of readSavedTerminals()) {
    const tab = store.tabs.find((t) => t.path === entry.repoPath);
    if (!tab) continue;
    createTerminalState(entry.path, tab.id, entry.repoPath);
  }
}

/** Refocus the visible terminal when the window regains focus. */
export function initTerminal(): void {
  window.addEventListener('focus', () => {
    if (store.activeTerminalPath) focusTerminal(store.activeTerminalPath);
  });
  // A reload/navigation tears down the renderer; reap its PTYs so dev reloads
  // don't leak shells (the sessions are keyed by content and recreated on load).
  window.addEventListener('pagehide', () => {
    window.liana?.pty?.closeAll?.();
  });
}
