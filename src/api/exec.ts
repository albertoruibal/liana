// Git command execution: process spawn, per-repo activity tracking, and the
// GitError type. Node-only. Mirrored by src/git/exec.ts.

import { spawn } from 'node:child_process';
import type { GitCommandRecord, RepoActivity } from '../types';

/** Field separator for `--pretty`/`--format` output, rendered as `\x1f` on the bar. */
export const UNIT = '\x1f';

/** Per-repository git activity, keyed by absolute repo path, for the status bar. */
interface ActivityState {
  /** Commands still running, oldest first; the last entry is the most recently started. */
  running: GitCommandRecord[];
  /** Most recently finished command of any kind. */
  last: GitCommandRecord | null;
  /** Most recent user-initiated commands, newest first, capped at HISTORY_LIMIT. */
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
      i++; // skip the option's value
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

/**
 * True for commands the user directly triggered (push, commit, rebase, …) vs
 * background reads the UI fires on every refresh (log, show, status, …). A few
 * internal plumbing calls are filtered by shape: `add`/`rm` stage for a commit,
 * and `reset`/`stash` only when they carry a pathspec (`reset -q -- <paths>`)
 * or are the read-only `stash list`.
 */
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

/** Snapshot of one repository's git activity for `/activity`. */
export function repoActivity(repoPath: string): RepoActivity {
  const state = activityFor(repoPath);
  // A running user action outranks a background read for the live line.
  const runningUser = [...state.running].reverse().find((r) => r.userInitiated);
  return {
    running: runningUser ?? state.running[state.running.length - 1] ?? null,
    // Prefer the last user action so a background `git show` doesn't bury a push.
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

export class GitError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
    /** HTTP status the route should return; git failures default to 500. */
    public readonly status: number = 500,
  ) {
    super(message);
  }
}

/** `GIT_TERMINAL_PROMPT=0` so a missing credential fails fast instead of hanging. */
export const NET_ENV: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: '0' };

export function gitRun(
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

  /** Retire the record from the running list and make it the latest finished command. */
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
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C', ...extraEnv },
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
