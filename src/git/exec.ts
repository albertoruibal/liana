// Browser-side mirror of src/api/exec.ts: git CLI execution, activity tracking,
// and the GitError type. Types match src/types.ts on both sides. Kept in sync
// with the Node backend on purpose (see AGENTS.md).

import { spawn } from 'node:child_process';
import type { GitCommandRecord, RepoActivity } from '../types';

export class GitError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
    /** HTTP status the caller should surface; git failures default to 500. */
    public readonly status: number = 500,
  ) {
    super(message);
  }
}

/** Per-repository git activity, keyed by absolute repo path, for the status bar. */
interface ActivityState {
  running: GitCommandRecord[];
  last: GitCommandRecord | null;
  history: GitCommandRecord[];
}

const activity = new Map<string, ActivityState>();

/** How many user-initiated commands to keep for the status-bar history popover. */
const HISTORY_LIMIT = 10;

function activityFor(repoPath: string): ActivityState {
  let state = activity.get(repoPath);
  if (!state) {
    state = { running: [], last: null, history: [] };
    activity.set(repoPath, state);
  }
  return state;
}

/**
 * The git subcommand, skipping global options like `-c key=value` so that
 * `-c core.editor=true rebase -i …` classifies as `rebase`.
 */
function gitSubcommand(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) break;
    if (arg === '-c' || arg === '-C') {
      i++;
      continue;
    }
    if (arg.startsWith('-')) continue;
    return arg;
  }
  return '';
}

/** Read-only / plumbing subcommands that should never appear as a user action. */
const READ_SUBCOMMANDS = new Set([
  'log',
  'show',
  'status',
  'rev-parse',
  'rev-list',
  'for-each-ref',
  'show-ref',
  'config',
  'remote',
  'ls-files',
  'cat-file',
  'diff',
  'merge-base',
  'symbolic-ref',
]);

/** True for user commands (push, commit, …) vs background reads (log, show, …). */
function isUserInitiated(args: string[]): boolean {
  const cmd = gitSubcommand(args);
  if (!cmd || READ_SUBCOMMANDS.has(cmd)) return false;
  if (cmd === 'add' || cmd === 'rm') return false;
  if (cmd === 'stash' && args.includes('list')) return false;
  if (cmd === 'reset' && args.includes('--')) return false;
  // `submodule status` is a background read; add/update/sync/deinit are user actions.
  if (cmd === 'submodule' && args.includes('status')) return false;
  // `worktree list` is a background read; add/remove/lock/… are user actions.
  if (cmd === 'worktree' && args.includes('list')) return false;
  return true;
}

/** Snapshot of one repository's git activity (mirrors `repoActivity` in src/api.ts). */
export function repoActivity(repoPath: string): RepoActivity {
  const state = activityFor(repoPath);
  const runningUser = [...state.running].reverse().find((r) => r.userInitiated);
  return {
    running: runningUser ?? state.running[state.running.length - 1] ?? null,
    last: state.history[0] ?? state.last,
    active: state.running.length,
    history: state.history,
  };
}

/** Quote a single argv token for display, leaving shell-safe tokens bare. */
function formatArg(arg: string): string {
  // Render control characters (the \x1f field separator, \n, \t, …) as escapes so
  // format-string argv stays on the status bar's single line.
  const safe = arg.replace(/[\x00-\x1f\x7f]/g, (c) => {
    const code = c.charCodeAt(0).toString(16).padStart(2, '0');
    return `\\x${code}`;
  });
  if (safe.length > 0 && !/[\s"'\\$`]/.test(safe)) return safe;
  return `'${safe.replace(/'/g, `'\\''`)}'`;
}

/** Human-readable command line, e.g. `git log --all --date-order`. */
function formatCommand(args: string[]): string {
  return ['git', ...args].map(formatArg).join(' ');
}

/** Run a git command in `repoPath`; resolves stdout, rejects GitError on nonzero exit. */
export function git(
  repoPath: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<string> {
  const state = activityFor(repoPath);
  const userInitiated = isUserInitiated(args);
  const record: GitCommandRecord = {
    argv: args,
    display: formatCommand(args),
    running: true,
    exitCode: null,
    durationMs: null,
    startedAt: Date.now(),
    finishedAt: null,
    failed: false,
    userInitiated,
  };
  state.running.push(record);

  const finish = (exitCode: number | null): void => {
    const idx = state.running.indexOf(record);
    if (idx !== -1) state.running.splice(idx, 1);
    record.running = false;
    record.exitCode = exitCode;
    record.finishedAt = Date.now();
    record.durationMs = record.finishedAt - record.startedAt;
    state.last = record;
    if (record.userInitiated) {
      state.history.unshift(record);
      if (state.history.length > HISTORY_LIMIT) state.history.length = HISTORY_LIMIT;
    }
  };

  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: repoPath,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        // Keep output stable regardless of user locale/config
        LC_ALL: 'C',
        ...extraEnv,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      record.failed = true;
      finish(null);
      reject(new GitError(`git failed to start: ${err.message}`, stderr));
    });
    child.on('close', (code) => {
      record.failed = code !== 0;
      finish(code);
      if (code === 0) resolve(stdout);
      // Some commands (e.g. `git stash apply`) report conflicts on stdout, so fall
      // back to it when stderr is empty rather than hiding git's explanation.
      else reject(new GitError(`git ${args[0]} failed (exit ${code})`, stderr.trim() || stdout.trim()));
    });
  });
}

export const UNIT = '\x1f'; // field separator for --pretty format

/** `GIT_TERMINAL_PROMPT=0` so a missing credential fails fast instead of hanging. */
export const NET_ENV: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: '0' };
