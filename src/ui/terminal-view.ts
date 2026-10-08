// Terminal main view: registers terminals, toggles visibility, and owns the
// tab-strip pill. Mirrors review-view's shape (one terminal per worktree) but
// keeps the xterm/PTY lifecycle in ./terminal.

import { renderCached } from './graph-view';
import { store, terminalForPath } from './store';
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
  const term = terminalForPath(path);
  if (!term) return;
  store.activePanel = { kind: 'terminal', repoId: term.repoId, path };
  // A terminal and the code-review view are mutually exclusive main views.
  applyPanel();
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
  if (!terminalForPath(path)) return;
  await showTerminal(path);
}

/** Close a terminal: dispose its session and fall back to the graph if visible. */
export function closeTerminal(path: string): void {
  const term = terminalForPath(path);
  if (!term) return;
  disposeTerminal(path);
  const owner = store.tabs.find((t) => t.id === term.repoId);
  owner?.terminals.delete(path);
  const panel = store.activePanel;
  if (panel.kind === 'terminal' && panel.path === path) {
    store.activePanel = { kind: 'graph' };
    applyPanel();
    renderCached();
  }
  persistTerminalTabs();
}

/**
 * Apply `store.activePanel` across the mutually exclusive main views: the graph
 * columns, the code-review view, and the terminal view. The single discriminant
 * is the source of truth, so one call repaints all three.
 */
export function applyPanel(): void {
  const panel = store.activePanel;
  const reviewOn = panel.kind === 'review';
  const termOn = panel.kind === 'terminal' && !!terminalForPath(panel.path);
  const graphOn = !reviewOn && !termOn;
  $('#review-view').hidden = !reviewOn;
  $('#terminal-view').hidden = !termOn;
  $('#graph-wrap').hidden = !graphOn;
  $('#detail-resizer').hidden = !graphOn;
  $('#detail-pane').hidden = !graphOn;
}

export function persistTerminalTabs(): void {
  try {
    const saved: SavedTerminal[] = [];
    for (const tab of store.tabs) {
      for (const s of tab.terminals.values()) saved.push({ path: s.path, repoPath: s.repoPath });
    }
    localStorage.setItem(TERMINAL_TABS_KEY, JSON.stringify(saved));
    const panel = store.activePanel;
    if (panel.kind === 'terminal') {
      localStorage.setItem(TERMINAL_ACTIVE_KEY, panel.path);
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
    const panel = store.activePanel;
    if (panel.kind === 'terminal') focusTerminal(panel.path);
  });
  // A reload/navigation tears down the renderer; reap its PTYs so dev reloads
  // don't leak shells (the sessions are keyed by content and recreated on load).
  window.addEventListener('pagehide', () => {
    window.liana?.pty?.closeAll?.();
  });
}
