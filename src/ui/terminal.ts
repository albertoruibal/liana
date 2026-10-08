// Embedded terminal: xterm.js bound to a PTY in the Electron main process.
// One shell per worktree, keyed by the worktree path. The PTY bridge is absent
// in plain browser mode (see src/liana.d.ts), where the terminal is unavailable.

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { $ } from './dom';
import { store, terminalForPath, TerminalState } from './store';

interface TerminalInstance {
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
  observer: ResizeObserver;
}

/** Live xterm instances, keyed by the worktree path (as are the TerminalStates). */
const instances = new Map<string, TerminalInstance>();

/** Basename of a POSIX/Windows path, for the tab label. */
function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** Map the app's CSS custom properties onto an xterm theme. */
function readTheme(): Record<string, string> {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string): string => css.getPropertyValue(name).trim();
  const bg = v('--bg-graph') || '#110e1d';
  const fg = v('--fg') || '#ece9f5';
  return {
    background: bg,
    foreground: fg,
    cursor: v('--accent') || fg,
    cursorAccent: bg,
    selectionBackground: v('--accent-soft') || 'rgba(167,139,250,0.3)',
    black: v('--bg') || '#0d0b16',
    red: v('--del') || '#fb7185',
    green: v('--add') || '#34d399',
    yellow: v('--warn') || '#fbbf24',
    blue: v('--accent-2') || '#22d3ee',
    magenta: v('--accent') || '#a78bfa',
    cyan: v('--accent-2') || '#22d3ee',
    white: fg,
    brightBlack: v('--fg-faint') || '#6f688c',
    brightWhite: fg,
  };
}

function monoFont(): string {
  const css = getComputedStyle(document.documentElement);
  return css.getPropertyValue('--mono').trim() || 'monospace';
}

/** The terminal whose worktree path matches `key`, if any. */
function findByKey(key: string): TerminalInstance | undefined {
  return instances.get(key);
}

/**
 * Re-fit `inst` only when it is actually laid out. Hiding a terminal sets its
 * box to zero, and `FitAddon` does not detect that: it reads the parent's
 * computed height through `parseInt`, which turns the unresolvable `100%` into
 * `100` rather than `NaN`, so it happily resizes to a bogus handful of rows.
 * Skipping unseen terminals leaves the buffer untouched; the observer refits
 * once the box grows back.
 */
function fitIfVisible(inst: TerminalInstance): void {
  if (inst.el.hidden) return;
  const rect = inst.el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;
  try {
    inst.fit.fit();
  } catch {
    // ignore transient zero-size measurements
  }
}

// PTY output is fanned out with the client key (the worktree path); route it to
// the owning terminal. This is race-free: the key is known before `open` returns.
let wired = false;
function wireBridge(): void {
  if (wired) return;
  const bridge = window.liana?.pty;
  if (!bridge) return;
  wired = true;
  bridge.onData((key, _id, data) => findByKey(key)?.term.write(data));
  bridge.onExit((key, id, exitCode) => {
    const inst = findByKey(key);
    const state = terminalForPath(key);
    if (state && state.id === id) state.id = null;
    if (inst) inst.term.write(`\r\n[process exited with code ${exitCode}]\r\n`);
  });
}

/** Create the xterm view for a terminal state and open its PTY. */
async function startSession(state: TerminalState): Promise<void> {
  const bridge = window.liana?.pty;
  if (!bridge) return;
  const host = $('#terminal-host');
  const el = document.createElement('div');
  el.className = 'terminal-xterm';
  el.hidden = true;
  host.appendChild(el);

  const term = new Terminal({
    fontFamily: monoFont(),
    fontSize: 13,
    cursorBlink: true,
    scrollback: 5000,
    theme: readTheme(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);
  // Re-fit whenever the pane changes size (window resize, resizer, tab switch).
  const observer = new ResizeObserver(() => {
    fitIfVisible(inst);
  });
  observer.observe(el);
  const inst: TerminalInstance = { term, fit, el, observer };
  instances.set(state.path, inst);

  // Size once the element has layout, then start the shell at that size.
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  fitIfVisible(inst);
  const id = await bridge.open({
    repoPath: state.repoPath,
    cwd: state.path,
    cols: term.cols || 80,
    rows: term.rows || 24,
    key: state.path,
  });
  // The view may have been closed while the session was opening.
  if (!instances.has(state.path)) {
    if (id !== null) bridge.close(id);
    return;
  }
  if (id === null) {
    term.write('Could not start a shell in this worktree.\r\n');
    return;
  }
  state.id = id;
  term.onData((data) => bridge.input(id, data));
  term.onResize(({ cols, rows }) => bridge.resize(id, cols, rows));
}

/** Show a terminal's DOM and focus it; hide the others. */
export function focusTerminal(path: string): void {
  for (const [p, inst] of instances) inst.el.hidden = p !== path;
  const inst = instances.get(path);
  if (!inst) return;
  // The view's ancestor may still be `display:none` at this point (the caller
  // reveals it in the same task), so fitting now would measure a stale, often
  // zero-sized box and leave xterm's canvas misaligned. Re-fit once the browser
  // has laid the terminal out, and only then focus.
  requestAnimationFrame(() => {
    if (instances.get(path) !== inst || inst.el.hidden) return;
    fitIfVisible(inst);
    inst.term.focus();
  });
}

/** Re-apply the current theme to every live terminal. */
export function recolorTerminals(): void {
  const theme = readTheme();
  for (const inst of instances.values()) {
    inst.term.options.theme = theme;
  }
}

/** True when the embedded terminal can run in this environment. */
export function terminalAvailable(): boolean {
  return window.liana?.canRunTerminal === true && !!window.liana?.pty;
}

/** Register a terminal for a worktree path (without starting its shell yet). */
export function createTerminalState(path: string, repoId: string, repoPath: string): TerminalState {
  const existing = terminalForPath(path);
  if (existing) return existing;
  const owner = store.tabs.find((t) => t.id === repoId);
  const state: TerminalState = { path, name: baseName(path), repoId, repoPath, id: null };
  owner?.terminals.set(path, state);
  return state;
}

/** Start the xterm/PTY for a terminal state if it is not already live. */
export async function ensureTerminalSession(path: string): Promise<void> {
  wireBridge();
  const state = terminalForPath(path);
  if (state && !instances.has(path)) await startSession(state);
}

/** Dispose a terminal's xterm instance and kill its PTY. */
export function disposeTerminal(path: string): void {
  const state = terminalForPath(path);
  if (state?.id) window.liana?.pty?.close(state.id);
  const inst = instances.get(path);
  if (inst) {
    inst.observer.disconnect();
    try {
      inst.term.dispose();
    } catch {
      // already disposed
    }
    inst.el.remove();
    instances.delete(path);
  }
}
