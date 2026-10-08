// Pseudoterminal host for the embedded terminal. Electron main-process only:
// node-pty runs here and output is streamed to the sandboxed renderer over IPC
// (see electron/preload.ts). Session state is keyed by an opaque per-session id;
// the renderer never gets a handle to the PTY itself.

import { statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import type { WebContents } from 'electron';
import * as pty from 'node-pty';

type PtyProcess = pty.IPty;

interface Session {
  proc: PtyProcess;
  /** Repository the session's cwd belongs to, for containment checks. */
  repoPath: string;
  /** Renderer-supplied key (the worktree path) echoed with every output frame. */
  key: string;
}

const sessions = new Map<string, Session>();

/** Default interactive shell: the user's $SHELL, falling back to bash/sh. */
function defaultShell(): string {
  const shell = process.env.SHELL?.trim();
  if (shell) return shell;
  return process.platform === 'win32' ? 'powershell.exe' : '/bin/bash';
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Identity of the repository a path belongs to. Runs `git rev-parse
 * --git-common-dir` so every linked worktree of a repository maps to the same
 * value as its main tree. Returns null when the path is not inside a repo.
 */
function repoIdentity(p: string): string | null {
  const out = spawnSync('git', ['-C', p, 'rev-parse', '--git-common-dir'], {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (out.status !== 0 || typeof out.stdout !== 'string') return null;
  return out.stdout.trim() || null;
}

/**
 * True when `cwd` is an existing directory inside the same repository as
 * `repoPath` (its main tree or any of its linked worktrees). The renderer
 * supplies both paths; this keeps a compromised renderer from opening a shell
 * anywhere on disk.
 */
function isAllowedCwd(repoPath: string, cwd: string): boolean {
  if (!cwd || !isDirectory(cwd) || !isDirectory(repoPath)) return false;
  const repoId = repoIdentity(repoPath);
  const cwdId = repoIdentity(cwd);
  return repoId !== null && repoId === cwdId;
}

/** Stable key for a repo identity within this process (identities are paths). */
function sessionKey(repoIdentityValue: string): string {
  return createHash('sha1').update(repoIdentityValue).digest('hex');
}

/**
 * Open a PTY in `cwd`. `cwd` must be a directory inside the same repository as
 * `repoPath`. Returns the session id, or null when the location is rejected.
 */
/**
 * Open a PTY in `cwd`. `cwd` must be a directory inside the same repository as
 * `repoPath`. `key` is echoed with every frame so the renderer can route output
 * to the right terminal without waiting for the session id. Returns the session
 * id, or null when the location is rejected.
 */
export function open(
  contents: WebContents,
  repoPath: string,
  cwd: string,
  cols: number,
  rows: number,
  key: string,
): string | null {
  if (!isAllowedCwd(repoPath, cwd)) return null;
  const shell = defaultShell();
  const proc = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cwd,
    cols: Math.max(20, Math.floor(cols)),
    rows: Math.max(5, Math.floor(rows)),
    env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
  });
  const id = randomBytes(12).toString('hex');
  sessions.set(id, { proc, repoPath: sessionKey(repoIdentity(repoPath) ?? repoPath), key });
  proc.onData((data) => {
    if (!contents.isDestroyed()) contents.send('liana:pty-data', { id, key, data });
  });
  proc.onExit(({ exitCode, signal }) => {
    sessions.delete(id);
    if (!contents.isDestroyed()) contents.send('liana:pty-exit', { id, key, exitCode, signal });
  });
  return id;
}

/** Forward keystrokes/paste from the renderer to a session. */
export function write(id: string, data: string): void {
  sessions.get(id)?.proc.write(data);
}

/** Tell the PTY its new viewport size after a resize. */
export function resize(id: string, cols: number, rows: number): void {
  const session = sessions.get(id);
  if (!session) return;
  session.proc.resize(Math.max(20, Math.floor(cols)), Math.max(5, Math.floor(rows)));
}

/** Terminate and forget one session. */
export function close(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  try {
    session.proc.kill();
  } catch {
    // already gone
  }
}

/** Close every session; all PTYs are reaped when the app quits. */
export function closeAll(): void {
  for (const id of [...sessions.keys()]) close(id);
}
