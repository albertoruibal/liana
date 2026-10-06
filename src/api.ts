// Transport-agnostic git backend: all /api route logic, no HTTP framework.
// Node-only — never import this from the renderer bundle (see AGENTS.md).
// `dev.ts` wraps `handleRequest` in Vite Connect middleware; `electron/server.ts`
// wraps it in node:http. Wrapper changes must be mirrored in `src/git.ts`.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { INTERACTIVE_REBASE_ENABLED } from './config';
import { parseCommitFiles, parseUnmerged } from './commit-files';
import type {
  BranchInfo,
  CommitFile,
  ConflictEntry,
  ConflictFile,
  GitCommandRecord,
  GitCommit,
  GitRef,
  MergeOperation,
  RebaseAction,
  RebaseTodoItem,
  RemoteStatus,
  RepoActivity,
  RepoState,
  RepoStatus,
  ResetMode,
  StashInfo,
  StatusEntry,
  SubmoduleInfo,
} from './types';

const UNIT = '\x1f';

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

function parseDecorations(decorated: string, commit: GitCommit): void {
  if (!decorated.trim()) return;
  for (const item of decorated.split(', ').map((s) => s.trim())) {
    let ref: GitRef;
    if (item === 'HEAD') {
      ref = { name: 'HEAD', kind: 'head' };
    } else if (item.startsWith('HEAD -> ')) {
      const branch = item.slice('HEAD -> '.length).replace(/^refs\/heads\//, '');
      commit.refs.push({ name: 'HEAD', kind: 'head' });
      ref = { name: branch, kind: 'local' };
    } else if (item.startsWith('tag: ')) {
      ref = { name: item.slice('tag: '.length).replace(/^refs\/tags\//, ''), kind: 'tag' };
    } else if (item.startsWith('refs/remotes/')) {
      ref = { name: item.slice('refs/remotes/'.length), kind: 'remote' };
    } else if (item.startsWith('refs/heads/')) {
      ref = { name: item.slice('refs/heads/'.length), kind: 'local' };
    } else {
      // Short %D falls back to the default remote as "origin/...".
      ref = { name: item, kind: item.startsWith('origin/') ? 'remote' : 'local' };
    }
    commit.refs.push(ref);
  }
}

async function loadLog(
  repoPath: string,
  limit: number,
  stashes?: Map<string, StashInfo>,
): Promise<GitCommit[]> {
  const fmt = ['%H', '%P', '%an', '%at', '%s', '%D'].join(UNIT);
  const args = [
    'log',
    '--all',
    '--date-order',
    '--decorate=full',
    `--pretty=format:${fmt}`,
    `--max-count=${limit}`,
    ...(stashes ? [...stashes.keys()] : []),
  ];
  const out = await gitRun(repoPath, args);
  const commits: GitCommit[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [hash = '', parents = '', author = '', ts = '', subject = '', decorated = ''] =
      line.split(UNIT);
    const stash = stashes?.get(hash);
    const commit: GitCommit = {
      hash,
      // Stash WIP commits expose [base, index, (untracked)]; only the base is a
      // real history commit, so drop the synthetic parents to avoid fake merges.
      parents: stash ? [...stash.parents] : parents ? parents.split(' ') : [],
      author,
      timestamp: Number(ts) || 0,
      subject: stash ? stash.message : subject,
      refs: [],
    };
    if (stash) {
      commit.isStash = true;
      commit.stash = stash;
      commit.refs.push({ name: stash.selector, kind: 'stash' });
    } else {
      parseDecorations(decorated, commit);
    }
    commits.push(commit);
  }
  return commits;
}

/**
 * Read `git stash list`. Returns stash metadata keyed by WIP commit hash plus the
 * set of synthetic index/untracked commits that must be hidden from the graph.
 */
async function loadStashes(
  repoPath: string,
): Promise<{ stashes: Map<string, StashInfo>; hidden: Set<string> }> {
  const fmt = ['%H', '%gd', '%gs', '%ct', '%an', '%P'].join(UNIT);
  const out = await gitRun(repoPath, ['stash', 'list', `--format=${fmt}`]);
  const stashes = new Map<string, StashInfo>();
  const hidden = new Set<string>();
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [hash = '', selector = '', subject = '', ts = '', author = '', parentList = ''] =
      line.split(UNIT);
    if (!hash) continue;
    const parents = parentList ? parentList.split(' ') : [];
    for (const parent of parents.slice(1)) hidden.add(parent);
    // "On <branch>: <message>", or just the raw subject for e.g. "WIP on ...".
    const m = /^On ([^:]+): (.*)$/.exec(subject);
    stashes.set(hash, {
      selector,
      hash,
      message: m?.[2] ?? subject,
      branch: m?.[1] ?? null,
      parents: parents.slice(0, 1),
      author,
      timestamp: Number(ts) || 0,
    });
  }
  return { stashes, hidden };
}

/**
 * Read every ref once. Returns the branch view plus a fingerprint over *all*
 * refs (heads, remotes, tags, stash) so a cached log can be invalidated when
 * any of them moves — tags included, since they decorate the graph too.
 */
async function loadRepoRefs(repoPath: string): Promise<{ state: RepoState; fingerprint: string }> {
  const [refsOut, symbolicOut] = await Promise.all([
    gitRun(repoPath, ['for-each-ref', '--format=%(refname)%00%(objectname)']),
    gitRun(repoPath, ['rev-parse', '--symbolic-full-name', 'HEAD']).catch(() => ''),
  ]);
  // "refs/heads/main" when on a branch, "HEAD" when detached
  const symbolic = symbolicOut.trim();
  const detachedHead = !symbolic.startsWith('refs/heads/');
  const headBranch = detachedHead ? null : symbolic.replace(/^refs\/heads\//, '');

  const branches: BranchInfo[] = [];
  for (const line of refsOut.split('\n')) {
    if (!line.trim()) continue;
    const [refname = '', hash = ''] = line.split('\x00');
    if (!refname.startsWith('refs/heads/') && !refname.startsWith('refs/remotes/')) continue;
    branches.push({
      name: refname.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\//, ''),
      hash,
      isHead: !detachedHead && refname === `refs/heads/${headBranch}`,
      isRemote: refname.startsWith('refs/remotes/'),
    });
  }

  const name = path.basename(repoPath);
  return {
    state: { name, headBranch, detachedHead, branches },
    // `refsOut` lists every ref (heads, remotes, tags, stash) with its object id,
    // so comparing it catches any ref move. HEAD name covers unborn/detached.
    fingerprint: `${detachedHead ? 'HEAD' : headBranch}\n${refsOut}`,
  };
}

async function loadStatus(repoPath: string): Promise<RepoStatus> {
  const out = await gitRun(repoPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const tokens = out.split('\0');
  const entries: StatusEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const line = tokens[i];
    if (!line) continue;
    const xy = line.slice(0, 2);
    const p = line.slice(3);
    if (!p) continue;
    // In -z mode rename/copy entries are `XY <to>\0<from>\0`; the extra
    // `<from>` token is the rename source, not a status line.
    let oldPath: string | null = null;
    if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') {
      if (i + 1 < tokens.length) {
        oldPath = tokens[i + 1] || null;
        i++;
      }
    }
    entries.push({ stagedX: xy[0] ?? ' ', unstagedY: xy[1] ?? ' ', path: p, oldPath });
  }
  return { entries };
}

/** True when HEAD resolves (false on an unborn branch, e.g. after `git init`). */
async function headExists(repoPath: string): Promise<boolean> {
  try {
    await gitRun(repoPath, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

/** Number of uncommitted (staged or unstaged) entries in the working tree. */
async function dirtyCount(repoPath: string): Promise<number> {
  return (await loadStatus(repoPath)).entries.length;
}

/** Guard for operations git refuses to run on a dirty tree; returns an error string or null. */
async function dirtyGuard(repoPath: string, op: string): Promise<string | null> {
  const n = await dirtyCount(repoPath);
  if (n === 0) return null;
  const changes = n === 1 ? 'change' : 'changes';
  return `${n} uncommitted ${changes} — commit or stash before ${op}`;
}

/**
 * Commit an explicit set of paths. `files` is intersected with the live status,
 * so callers can't stage paths outside the working tree. Checked files are
 * staged (`add -A`), and files already staged but not selected are unstaged, so
 * the commit contains exactly the selected set.
 */
async function createCommit(repoPath: string, message: string, files: string[]): Promise<string> {
  const status = await loadStatus(repoPath);
  const selected = new Set(files);
  const toStage = status.entries.filter((e) => selected.has(e.path)).map((e) => e.path);
  const toUnstage = status.entries
    .filter((e) => !selected.has(e.path) && e.stagedX !== ' ' && e.stagedX !== '?')
    .map((e) => e.path);
  if (toUnstage.length > 0) {
    if (await headExists(repoPath)) {
      await gitRun(repoPath, ['reset', '-q', '--', ...toUnstage]);
    } else {
      // No HEAD yet: `reset` has nothing to reset against, so drop the index entries.
      await gitRun(repoPath, ['rm', '--cached', '-r', '--', ...toUnstage]);
    }
  }
  if (toStage.length > 0) await gitRun(repoPath, ['add', '-A', '--', ...toStage]);
  await gitRun(repoPath, ['commit', '-m', message]);
  return (await gitRun(repoPath, ['rev-parse', 'HEAD'])).trim();
}

async function rebaseOnto(repoPath: string, onto: string): Promise<string> {
  const out = await gitRun(repoPath, ['rebase', onto]);
  return out.trim();
}

/** Merge `ref` into the checked-out branch; `--no-edit` keeps git from opening an editor. */
async function mergeBranch(repoPath: string, ref: string): Promise<string> {
  const out = await gitRun(repoPath, ['merge', '--no-edit', ref]);
  return out.trim();
}

async function cherryPick(
  repoPath: string,
  ref: string,
  opts: { mainline?: number; record?: boolean } = {},
): Promise<string> {
  const args = ['cherry-pick'];
  if (opts.record) args.push('-x');
  if (opts.mainline !== undefined) args.push('-m', String(opts.mainline));
  args.push(ref);
  const out = await gitRun(repoPath, args);
  return out.trim();
}

/**
 * Revert `ref` on the current branch, creating the inverse commit.
 * `--no-edit` keeps git from opening an editor; `mainline` selects the parent
 * of a merge commit (git -m N). A conflict leaves REVERT_HEAD for the banner.
 */
async function revert(
  repoPath: string,
  ref: string,
  opts: { mainline?: number } = {},
): Promise<string> {
  const args = ['revert', '--no-edit'];
  if (opts.mainline !== undefined) args.push('-m', String(opts.mainline));
  args.push(ref);
  const out = await gitRun(repoPath, args);
  return out.trim();
}

// --- Conflicts (merge / rebase / cherry-pick / revert) ---

/** Resolve a possibly-relative `--git-path` result against the repo's work tree. */
function repoAbs(repoPath: string, gitPath: string): string {
  return path.isAbsolute(gitPath) ? gitPath : path.join(repoPath, gitPath);
}

/** True when the given git metadata path currently exists on disk. */
async function gitPathExists(repoPath: string, name: string): Promise<boolean> {
  try {
    const out = (await gitRun(repoPath, ['rev-parse', '--git-path', name])).trim();
    return fs.existsSync(repoAbs(repoPath, out));
  } catch {
    return false;
  }
}

/** Read a file inside the git dir (e.g. `rebase-merge/onto`), or null when absent. */
async function readGitPath(repoPath: string, name: string): Promise<string | null> {
  try {
    const out = (await gitRun(repoPath, ['rev-parse', '--git-path', name])).trim();
    const abs = repoAbs(repoPath, out);
    return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8').trim() : null;
  } catch {
    return null;
  }
}

/**
 * Merge / rebase / cherry-pick / revert state, read from git's own metadata files
 * (never inferred). `onto` is the commit the operation applies onto when known.
 * `conflicts` may be passed in to avoid a second `git ls-files -u`.
 */
async function loadMergeState(repoPath: string, conflicts?: ConflictEntry[]): Promise<MergeOperation> {
  const [rebaseMerge, rebaseApply, mergeHead, cherryHead, revertHead, unmerged] = await Promise.all([
    gitPathExists(repoPath, 'rebase-merge'),
    gitPathExists(repoPath, 'rebase-apply'),
    gitPathExists(repoPath, 'MERGE_HEAD'),
    gitPathExists(repoPath, 'CHERRY_PICK_HEAD'),
    gitPathExists(repoPath, 'REVERT_HEAD'),
    conflicts ?? loadConflicts(repoPath),
  ]);
  let kind: MergeOperation['kind'] = 'none';
  let onto: string | null = null;
  if (rebaseMerge || rebaseApply) {
    kind = 'rebase';
    onto = await readGitPath(repoPath, 'rebase-merge/onto');
  } else if (mergeHead) {
    kind = 'merge';
    onto = await readGitPath(repoPath, 'MERGE_HEAD');
  } else if (cherryHead) {
    kind = 'cherry-pick';
    onto = await readGitPath(repoPath, 'CHERRY_PICK_HEAD');
  } else if (revertHead) {
    kind = 'revert';
    onto = await readGitPath(repoPath, 'REVERT_HEAD');
  }
  return { kind, inProgress: kind !== 'none', onto, conflictCount: unmerged.length };
}

/** Unmerged index entries (`git ls-files -u`), parsed into conflict records. */
async function loadConflicts(repoPath: string): Promise<ConflictEntry[]> {
  const out = await gitRun(repoPath, ['ls-files', '-u', '-z']);
  return parseUnmerged(out);
}

/** A blob or gitlink id as text, or null when the path has no such index stage. */
async function readStage(repoPath: string, stage: number, filePath: string): Promise<string | null> {
  try {
    const out = await gitRun(repoPath, ['show', `:${stage}:${filePath}`]);
    return out;
  } catch {
    return null;
  }
}

/** Heuristic for binary stage content: a NUL byte in the first 8000 chars. */
function looksBinary(text: string): boolean {
  return text.slice(0, 8000).includes('\0');
}

/** Base / ours / theirs contents for one conflicted path, for the resolve dialog. */
async function loadConflictFile(repoPath: string, filePath: string): Promise<ConflictFile> {
  const conflicts = await loadConflicts(repoPath);
  const entry = conflicts.find((c) => c.path === filePath);
  if (!entry) throw new GitError(`Not a conflicted path: ${filePath}`, 'Path is not unmerged', 400);
  const [base, ours, theirs] = await Promise.all([
    readStage(repoPath, 1, filePath),
    readStage(repoPath, 2, filePath),
    readStage(repoPath, 3, filePath),
  ]);
  const isBinary = [base, ours, theirs].some((t) => t !== null && looksBinary(t));
  return {
    path: filePath,
    type: entry.type,
    hasBase: entry.baseHash !== null,
    hasOurs: entry.oursHash !== null,
    hasTheirs: entry.theirsHash !== null,
    isBinary,
    isSubmodule: entry.isSubmodule,
    base: isBinary && !entry.isSubmodule ? null : base,
    ours: isBinary && !entry.isSubmodule ? null : ours,
    theirs: isBinary && !entry.isSubmodule ? null : theirs,
  };
}

/**
 * Resolve one conflicted path to a side (`ours`/`theirs`) or accept the working-tree
 * file as-is (`resolved`). Uses git's own checkout/rm/add; Liana writes no content.
 */
async function resolveConflict(
  repoPath: string,
  filePath: string,
  resolution: 'ours' | 'theirs' | 'resolved',
): Promise<void> {
  if (resolution === 'resolved') {
    await gitRun(repoPath, ['add', '--', filePath]);
    return;
  }
  try {
    await gitRun(repoPath, ['checkout', `--${resolution}`, '--', filePath]);
    await gitRun(repoPath, ['add', '-A', '--', filePath]);
  } catch {
    // `git checkout --<side>` only fails when that side has no version of the path
    // (a delete/modify conflict), so choosing it means removing the file.
    await gitRun(repoPath, ['rm', '-f', '-q', '--', filePath]).catch(() => '');
  }
}

/** Continue the in-progress operation without opening an editor. */
async function continueOperation(repoPath: string): Promise<string> {
  const { kind } = await loadMergeState(repoPath);
  if (kind === 'none') throw new GitError('No operation to continue', '', 400);
  if (kind === 'revert') {
    // `git revert --continue` opens an editor; commit explicitly instead.
    return (await gitRun(repoPath, ['commit', '--no-edit'])).trim();
  }
  return (await gitRun(repoPath, ['-c', 'core.editor=true', kind, '--continue'])).trim();
}

/** Abort the in-progress operation, restoring the pre-operation state. */
async function abortOperation(repoPath: string): Promise<string> {
  const { kind } = await loadMergeState(repoPath);
  if (kind === 'none') throw new GitError('No operation to abort', '', 400);
  return (await gitRun(repoPath, [kind, '--abort'])).trim();
}

/** Skip the current patch of an in-progress rebase, cherry-pick, or revert. */
async function skipOperation(repoPath: string): Promise<string> {
  const { kind } = await loadMergeState(repoPath);
  if (kind === 'none') throw new GitError('No operation to skip', '', 400);
  if (kind === 'merge') throw new GitError('Cannot skip a merge', 'Abort the merge instead', 400);
  return (await gitRun(repoPath, [kind, '--skip'])).trim();
}

// --- Submodules ---

/** Parse `.gitmodules` (`git config -f .gitmodules --get-regexp`) into per-name fields. */
function parseGitmodules(out: string): Map<string, { path?: string; url?: string; branch?: string }> {
  const mods = new Map<string, { path?: string; url?: string; branch?: string }>();
  for (const line of out.split('\n')) {
    const m = /^submodule\.(.+?)\.(path|url|branch)\s+(.*)$/.exec(line.trim());
    if (!m) continue;
    const name = m[1] ?? '';
    const key = m[2] as 'path' | 'url' | 'branch';
    const mod = mods.get(name) ?? {};
    mod[key] = m[3] ?? '';
    mods.set(name, mod);
  }
  return mods;
}

/** Configured submodules with their checked-out state (`git submodule status`). */
async function loadSubmodules(repoPath: string): Promise<SubmoduleInfo[]> {
  const cfgOut = await gitRun(repoPath, ['config', '-f', '.gitmodules', '--get-regexp', '.']).catch(() => '');
  const mods = parseGitmodules(cfgOut);
  const statusOut = await gitRun(repoPath, ['submodule', 'status', '--recursive']).catch(() => '');
  const byPath = new Map<string, SubmoduleInfo>();
  for (const [name, mod] of mods) {
    if (!mod.path) continue;
    byPath.set(mod.path, {
      name,
      path: mod.path,
      url: mod.url ?? '',
      branch: mod.branch ?? null,
      recordedHash: null,
      worktreeHash: null,
      status: 'uninitialized',
    });
  }
  for (const raw of statusOut.split('\n')) {
    if (!raw.trim()) continue;
    const prefix = raw[0] ?? ' ';
    const rest = raw.slice(1);
    const m = /^([0-9a-f]{7,64})\s+(\S+)/.exec(rest);
    if (!m) continue;
    const hash = m[1] ?? '';
    const subPath = m[2] ?? '';
    const entry = byPath.get(subPath) ?? {
      name: subPath,
      path: subPath,
      url: '',
      branch: null,
      recordedHash: null,
      worktreeHash: null,
      status: 'untracked' as const,
    };
    if (prefix === '-') {
      entry.recordedHash = hash;
      entry.worktreeHash = null;
      entry.status = 'uninitialized';
    } else {
      entry.worktreeHash = hash;
      entry.status = prefix === '+' ? 'modified' : prefix === 'U' ? 'conflicted' : 'current';
    }
    byPath.set(subPath, entry);
  }
  for (const entry of byPath.values()) {
    if (entry.recordedHash === null) {
      // Recorded commit id lives in the superproject's index for the gitlink.
      try {
        const out = (await gitRun(repoPath, ['ls-files', '--stage', '--', entry.path])).trim();
        const m = /^\d+\s+([0-9a-f]+)/.exec(out);
        entry.recordedHash = m?.[1] ?? null;
      } catch {
        entry.recordedHash = null;
      }
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** Run a network submodule command with the same no-prompt environment as push/pull. */
async function submoduleNetwork(repoPath: string, args: string[]): Promise<string> {
  return (await gitRun(repoPath, ['submodule', ...args], NET_ENV)).trim();
}

/** `git submodule update`; `--init` initializes, `--remote` tracks the remote branch. */
async function submoduleUpdate(
  repoPath: string,
  opts: { remote?: boolean; init?: boolean } = {},
): Promise<string> {
  const args = ['update'];
  if (opts.init) args.push('--init');
  if (opts.remote) args.push('--remote');
  return submoduleNetwork(repoPath, args);
}

/** `git submodule sync --recursive`: update the submodule URLs from `.gitmodules`. */
async function submoduleSync(repoPath: string): Promise<string> {
  return submoduleNetwork(repoPath, ['sync', '--recursive']);
}

/** `git submodule add`: clone `url` into `path` (defaults to a derived directory). */
async function submoduleAdd(
  repoPath: string,
  url: string,
  dest?: string,
  branch?: string,
): Promise<string> {
  const args = ['add', '-q'];
  if (branch?.trim()) args.push('-b', branch.trim());
  args.push(url);
  if (dest?.trim()) args.push(dest.trim());
  return submoduleNetwork(repoPath, args);
}

/** `git submodule deinit <path>`: unregister a submodule and clear its work tree. */
async function submoduleDeinit(repoPath: string, dest: string, force = false): Promise<string> {
  const args = ['deinit'];
  if (force) args.push('-f');
  args.push('--', dest);
  return (await gitRun(repoPath, ['submodule', ...args])).trim();
}

/**
 * History of a submodule, read by running the graph's `git log` inside the
 * submodule's own repository. `subPath` is resolved under `repoPath` and must not
 * escape it.
 */
async function loadSubmoduleLog(
  repoPath: string,
  subPath: string,
  limit = 300,
): Promise<GitCommit[]> {
  const abs = path.resolve(repoPath, subPath);
  const root = path.resolve(repoPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new GitError(`Invalid submodule path: ${subPath}`, 'Path is outside the repository', 400);
  }
  if (!fs.existsSync(abs)) {
    throw new GitError(`Submodule not initialized: ${subPath}`, 'Run submodule update first', 400);
  }
  return loadLog(abs, limit);
}

/**
 * Files changed by a commit, with per-file line counts. Uses `--first-parent` so a
 * merge commit reports the changes it introduces relative to its mainline parent,
 * matching `git show`.
 */
async function commitFiles(repoPath: string, hash: string): Promise<CommitFile[]> {
  const [nameStatusOut, numstatOut, rawOut] = await Promise.all([
    gitRun(repoPath, ['show', '--name-status', '-z', '--format=', '--find-renames', '--first-parent', hash]),
    gitRun(repoPath, ['show', '--numstat', '-z', '--format=', '--find-renames', '--first-parent', hash]),
    gitRun(repoPath, ['show', '--raw', '-z', '--format=', '--find-renames', '--first-parent', hash]),
  ]);
  return parseCommitFiles(nameStatusOut, numstatOut, rawOut);
}

/** Unified diff for one file of a commit; `oldPath` included so renames diff as renames. */
async function commitPatch(
  repoPath: string,
  hash: string,
  filePath: string,
  oldPath: string | null,
): Promise<string> {
  const paths = oldPath && oldPath !== filePath ? [oldPath, filePath] : [filePath];
  return (
    await gitRun(repoPath, [
      'show',
      '--format=',
      '--no-color',
      '--find-renames',
      '--first-parent',
      hash,
      '--',
      ...paths,
    ])
  ).trim();
}

// Git's well-known empty tree object id; diffing against it works on an unborn HEAD.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * Unified diff of a working-tree path against HEAD (staged + unstaged combined).
 * `oldPath` is included so a rename diffs as a rename. On an unborn branch the
 * empty tree stands in for HEAD, and untracked files (which `git diff HEAD`
 * skips) fall back to a `/dev/null` comparison.
 */
async function worktreePatch(
  repoPath: string,
  filePath: string,
  oldPath: string | null,
): Promise<string> {
  const paths = oldPath && oldPath !== filePath ? [oldPath, filePath] : [filePath];
  const base = (await headExists(repoPath)) ? 'HEAD' : EMPTY_TREE;
  try {
    const out = await gitRun(repoPath, [
      'diff',
      '--no-color',
      '--find-renames',
      base,
      '--',
      ...paths,
    ]);
    if (out.trim()) return out.trim();
  } catch {
    // Fall through to the untracked-file check below.
  }
  // An empty diff means either a clean tracked path (no output) or an untracked
  // path (`git diff HEAD` ignores untracked files). Only the latter gets the
  // /dev/null comparison, so a clean file doesn't render as brand new.
  try {
    await gitRun(repoPath, ['ls-files', '--error-unmatch', '--', filePath]);
    return '';
  } catch {
    // Path is untracked — compare it against /dev/null below.
  }
  try {
    return (
      await gitRun(repoPath, ['diff', '--no-color', '--no-index', '--', '/dev/null', filePath])
    ).trim();
  } catch (err) {
    // `--no-index` exits 1 whenever the files differ, and gitRun surfaces that
    // stdout through GitError.stderr. A real failure (missing path) has none.
    if (err instanceof GitError && err.stderr.trim().startsWith('diff --git')) {
      return err.stderr.trim();
    }
    return '';
  }
}

// --- Interactive rebase (Phase 5) ---

interface RebasePlan {
  /** Resolved commit hash of the rebase base. */
  onto: string;
  /** Commits to replay, oldest first (onto..HEAD). */
  items: Array<Omit<RebaseTodoItem, 'action' | 'message'>>;
}

async function resolveCommit(repoPath: string, ref: string): Promise<string> {
  return (await gitRun(repoPath, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
}

/** Commits between `onto` and HEAD, oldest first, that an interactive rebase would replay. */
async function loadRebasePlan(repoPath: string, onto: string): Promise<RebasePlan> {
  const ontoHash = await resolveCommit(repoPath, onto);
  const fmt = ['%H', '%s', '%an', '%at'].join(UNIT);
  const out = await gitRun(repoPath, [
    'log',
    '--reverse',
    `--pretty=format:${fmt}`,
    `${ontoHash}..HEAD`,
  ]);
  const items: RebasePlan['items'] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [hash = '', subject = '', author = '', ts = ''] = line.split(UNIT);
    items.push({ hash, subject, author, timestamp: Number(ts) || 0 });
  }
  return { onto: ontoHash, items };
}

const REBASE_ACTIONS: readonly RebaseAction[] = ['pick', 'drop', 'reword', 'squash'];

/**
 * Run an interactive rebase from a generated todo list, without opening an editor.
 * Deterministic by construction:
 * - `reword` / `squash` are emitted as `fixup` + `exec git commit --amend -F <msgfile>`,
 *   so the replacement message is applied with no GIT_EDITOR interaction.
 * - a generated `sequence.editor` script writes the todo file.
 */
async function executeRebase(repoPath: string, onto: string, items: RebaseTodoItem[]): Promise<string> {
  const plan = await loadRebasePlan(repoPath, onto);
  const known = new Set(plan.items.map((i) => i.hash));
  if (items.length === 0) throw new GitError('Empty rebase todo', 'Nothing to rebase');

  // Resolve abbreviated hashes the UI may send to their full form.
  const resolved: RebaseTodoItem[] = [];
  for (const item of items) {
    try {
      resolved.push({ ...item, hash: await resolveCommit(repoPath, item.hash) });
    } catch {
      throw new GitError(`Unknown commit ${item.hash}`, 'Commit is not in the rebase range');
    }
  }
  items = resolved;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liana-rebase-'));
  try {
    const todoLines: string[] = [];
    // `squash`/`fixup`-style actions fold into the previous kept commit.
    let haveKept = false;
    items.forEach((item, idx) => {
      if (!known.has(item.hash)) {
        throw new GitError(`Unknown commit ${item.hash}`, 'Commit is not in the rebase range');
      }
      if (!REBASE_ACTIONS.includes(item.action)) {
        throw new GitError(`Bad action ${item.action}`, 'Unknown rebase action');
      }
      if (item.action === 'drop') {
        todoLines.push(`drop ${item.hash}`);
        return;
      }
      if ((item.action === 'reword' || item.action === 'squash') && !item.message?.trim()) {
        throw new GitError('Missing message', `${item.action} needs a message`);
      }
      if (item.action === 'squash' && !haveKept) {
        throw new GitError('Cannot squash first commit', 'Nothing to squash into');
      }

      if (item.action === 'squash') {
        todoLines.push(`fixup ${item.hash}`);
      } else {
        todoLines.push(`pick ${item.hash}`);
        haveKept = true;
      }

      if (item.action === 'reword' || item.action === 'squash') {
        const msgPath = path.join(dir, `msg-${idx}`);
        fs.writeFileSync(msgPath, `${item.message!.trim()}\n`);
        todoLines.push(`exec git commit --amend -F '${msgPath}'`);
      }
    });

    const seqEditor = path.join(dir, 'seq-editor.sh');
    const body = todoLines.join('\n');
    fs.writeFileSync(
      seqEditor,
      `#!/bin/sh\ncat > "$1" <<'LIANA_TODO_EOF'\n${body}\nLIANA_TODO_EOF\n`,
      { mode: 0o755 },
    );

    return (
      await gitRun(repoPath, ['-c', 'core.editor=true', 'rebase', '-i', plan.onto], {
        GIT_SEQUENCE_EDITOR: seqEditor,
      })
    ).trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- Branches and tags ---

const REF_NAME_RE = /^[^\s~^:?*[\\]+$/;

/** Reject names git would misinterpret as an option, a range, or a path. */
function validRefName(name: string): boolean {
  return (
    !!name &&
    !name.startsWith('-') &&
    !name.startsWith('.') &&
    !name.endsWith('.') &&
    !name.includes('..') &&
    !name.includes('//') &&
    !name.includes('@{') &&
    !name.endsWith('.lock') &&
    REF_NAME_RE.test(name)
  );
}

/**
 * Check out a branch. Local names are checked out directly; for a remote-tracking
 * ref like `origin/feature` this creates (or reuses) the local `feature` branch and
 * tracks the remote — purely local, no fetch.
 */
async function checkoutBranch(repoPath: string, name: string, remote = false): Promise<void> {
  if (!remote) {
    await gitRun(repoPath, ['checkout', name]);
    return;
  }
  const branchName = remoteBranchLocalName(name);
  const exists = await gitRun(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`])
    .then(() => true)
    .catch(() => false);
  if (exists) {
    await gitRun(repoPath, ['checkout', branchName]);
  } else {
    await gitRun(repoPath, ['checkout', '-b', branchName, '--track', name]);
  }
}

/** Local branch name a remote-tracking ref should check out as, or throw. */
function remoteBranchLocalName(name: string): string {
  const m = /^([^/]+)\/(.+)$/.exec(name);
  const branch = m?.[2] ?? '';
  if (!m || !m[1] || !branch || branch === 'HEAD' || !validRefName(branch)) {
    throw new GitError(`Not a remote branch: ${name}`, '');
  }
  return branch;
}

/** `git branch -b` plus checkout; fails if the branch already exists. */
async function createBranch(repoPath: string, name: string, ref: string): Promise<void> {
  await gitRun(repoPath, ['checkout', '-b', name, ref]);
}

async function deleteBranch(repoPath: string, name: string): Promise<void> {
  await gitRun(repoPath, ['branch', '-D', name]);
}

/** Delete the branch on the remote and its tracking ref (`git push --delete`). */
async function deleteRemoteBranchPush(repoPath: string, name: string): Promise<void> {
  const m = /^([^/]+)\/(.+)$/.exec(name);
  if (!m || !m[1] || !m[2]) throw new GitError(`Not a remote branch: ${name}`, '');
  await gitRun(repoPath, ['push', m[1], '--delete', m[2]], { GIT_TERMINAL_PROMPT: '0' });
}

// --- Remotes: push / pull / login (network) ---

/** `GIT_TERMINAL_PROMPT=0` so a missing credential fails fast instead of hanging. */
const NET_ENV: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: '0' };

/** Current branch name, or null when HEAD is detached / unborn. */
async function currentBranch(repoPath: string): Promise<string | null> {
  try {
    const name = (await gitRun(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    return name && name !== 'HEAD' ? name : null;
  } catch {
    return null;
  }
}

/** Configured remotes with their fetch URLs, de-duplicated by name. */
async function loadRemotes(repoPath: string): Promise<Array<{ name: string; url: string }>> {
  const names = (await gitRun(repoPath, ['remote'])).split('\n').map((s) => s.trim()).filter(Boolean);
  const remotes: Array<{ name: string; url: string }> = [];
  for (const name of names) {
    let url = '';
    try {
      url = (await gitRun(repoPath, ['remote', 'get-url', name])).trim();
    } catch {
      url = '';
    }
    remotes.push({ name, url });
  }
  return remotes;
}

/** Upstream ref of the checked-out branch, e.g. "origin/main", or null when unset. */
async function upstreamRef(repoPath: string): Promise<string | null> {
  try {
    const out = (
      await gitRun(repoPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
    ).trim();
    return out || null;
  } catch {
    return null;
  }
}

async function loadRemoteStatus(repoPath: string): Promise<RemoteStatus> {
  const [branch, remotes, upstream, helper] = await Promise.all([
    currentBranch(repoPath),
    loadRemotes(repoPath).catch(() => []),
    upstreamRef(repoPath),
    gitRun(repoPath, ['config', '--get', 'credential.helper']).catch(() => ''),
  ]);
  let ahead = 0;
  let behind = 0;
  if (upstream) {
    try {
      const out = (
        await gitRun(repoPath, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`])
      ).trim();
      const [behindStr = '0', aheadStr = '0'] = out.split(/\s+/);
      behind = Number(behindStr) || 0;
      ahead = Number(aheadStr) || 0;
    } catch {
      // Upstream ref is gone (not fetched yet): report no divergence.
    }
  }
  return {
    currentBranch: branch,
    remotes,
    upstream,
    ahead,
    behind,
    credentialHelper: helper.trim() || null,
  };
}

/**
 * Push the checked-out branch. With an explicit `remote`/`branch` it pushes that
 * pair; otherwise the branch's upstream is used, or a single configured remote is
 * adopted with `-u` when there is no upstream yet. `force` uses
 * `--force-with-lease`, so an unexpected remote update still rejects the push.
 */
async function pushBranch(
  repoPath: string,
  remote?: string,
  branch?: string,
  force = false,
): Promise<string> {
  const branchName = branch?.trim() || (await currentBranch(repoPath));
  if (!branchName) throw new GitError('Cannot push: detached HEAD', 'Check out a branch first', 400);

  const lease = force ? ['--force-with-lease'] : [];
  const remotes = await loadRemotes(repoPath);
  const target = remote?.trim() || '';
  if (target) {
    if (!remotes.some((r) => r.name === target))
      throw new GitError(`Unknown remote: ${target}`, 'Pick a configured remote', 400);
    const upstream = await upstreamRef(repoPath);
    if (branch || !upstream) {
      return (await gitRun(repoPath, ['push', ...lease, '-u', target, branchName], NET_ENV)).trim();
    }
    return (await gitRun(repoPath, ['push', ...lease, target], NET_ENV)).trim();
  }

  if (await upstreamRef(repoPath)) {
    return (await gitRun(repoPath, ['push', ...lease], NET_ENV)).trim();
  }
  if (remotes.length === 0) {
    throw new GitError('No remote configured', 'Add a remote with `git remote add` first', 400);
  }
  if (remotes.length > 1) {
    throw new GitError('Multiple remotes configured', 'Pick a remote to push to', 400);
  }
  const only = remotes[0]!;
  return (await gitRun(repoPath, ['push', ...lease, '-u', only.name, branchName], NET_ENV)).trim();
}

/**
 * Pull the checked-out branch (merge). Local changes are allowed through; git
 * itself refuses (and the caller surfaces its stderr) when they'd be overwritten.
 */
async function pullBranch(repoPath: string, remote?: string, branch?: string): Promise<string> {
  const target = remote?.trim() || '';
  if (target) {
    const branchName = branch?.trim() || (await currentBranch(repoPath));
    if (!branchName)
      throw new GitError('Cannot pull: detached HEAD', 'Check out a branch first', 400);
    return (await gitRun(repoPath, ['pull', target, branchName], NET_ENV)).trim();
  }
  if (!(await upstreamRef(repoPath))) {
    throw new GitError('No upstream configured', 'Push the branch first to set its upstream', 400);
  }
  return (await gitRun(repoPath, ['pull'], NET_ENV)).trim();
}

/** `git ls-remote` a remote to verify connectivity and credentials. */
async function testRemote(repoPath: string, remote: string): Promise<void> {
  const name = remote.trim();
  if (!name) throw new GitError('Missing remote', 'Pick a configured remote', 400);
  const remotes = await loadRemotes(repoPath);
  if (!remotes.some((r) => r.name === name))
    throw new GitError(`Unknown remote: ${name}`, 'Pick a configured remote', 400);
  await gitRun(repoPath, ['ls-remote', '--exit-code', name], NET_ENV);
}

async function createTag(repoPath: string, name: string, ref: string): Promise<void> {
  await gitRun(repoPath, ['tag', name, ref]);
}

async function deleteTag(repoPath: string, name: string): Promise<void> {
  await gitRun(repoPath, ['tag', '-d', name]);
}

// --- Reset ---

const RESET_MODES: readonly ResetMode[] = ['soft', 'mixed', 'hard'];

/** Move HEAD (and the checked-out branch) to `ref`, discarding changes for hard. */
async function resetBranch(repoPath: string, mode: ResetMode, ref: string): Promise<void> {
  await gitRun(repoPath, ['reset', `--${mode}`, ref]);
}

// --- Stash ---

/** Resolve a stash WIP commit hash to its current reflog selector. */
async function resolveStash(repoPath: string, hash: string): Promise<string> {
  const { stashes } = await loadStashes(repoPath);
  const info = stashes.get(hash);
  if (!info) throw new GitError(`Unknown stash ${hash}`, 'No such stash');
  return info.selector;
}

/** `git stash push`; `includeUntracked` maps to `-u`. */
async function createStash(
  repoPath: string,
  message: string,
  includeUntracked: boolean,
): Promise<string> {
  const m = message.trim();
  const args = ['stash', 'push'];
  if (m) args.push('-m', m);
  if (includeUntracked) args.push('-u');
  const out = await gitRun(repoPath, args);
  // With no local changes git exits 0 and prints "No local changes to save".
  if (/No local changes to save/i.test(out)) return '';
  const { stashes } = await loadStashes(repoPath);
  // The newest stash is stash@{0}; report its WIP hash.
  const first = stashes.values().next().value as StashInfo | undefined;
  return first?.hash ?? '';
}

/** `git stash apply` a selector; keeps the stash in place. */
async function applyStash(repoPath: string, selector: string): Promise<string> {
  return (await gitRun(repoPath, ['stash', 'apply', selector])).trim();
}

/** `git stash drop` a selector; removes one stash entry. */
async function dropStash(repoPath: string, selector: string): Promise<string> {
  return (await gitRun(repoPath, ['stash', 'drop', selector])).trim();
}

async function resolveOpenRepo(raw: string): Promise<string | null> {
  if (!raw.trim()) return null;
  const expanded = raw.startsWith('~') ? path.join(process.env.HOME ?? '', raw.slice(1)) : raw;
  const abs = path.resolve(expanded);
  try {
    const st = fs.statSync(abs);
    if (!st.isDirectory()) return null;
  } catch {
    return null;
  }
  try {
    await gitRun(abs, ['rev-parse', '--git-dir']);
  } catch {
    return null;
  }
  return abs;
}

// --- HTTP-agnostic request handling ---

export interface ApiResponse {
  status: number;
  body: unknown;
}

/** A repository the server can serve, addressed by opaque `id` on each request. */
export interface RepoEntry {
  id: string;
  path: string;
  name: string;
}

export interface Api {
  handle(route: string, method: string, rawBody: string, repoId?: string): Promise<ApiResponse>;
}

export function createApi(defaultRepo: string | null): Api {
  // Validated repositories, keyed by a per-process opaque id. The client owns the
  // tab list; the server only maps ids → absolute paths for the life of the process.
  const repos = new Map<string, { path: string; name: string }>();
  let nextId = 1;

  // Parsed log cache, keyed by repo id. `git log --all` is the most expensive
  // read on `/state`; it only changes when a ref (or the stash list) moves, so
  // fingerprint the refs and reuse the parsed commits otherwise. Status and
  // remote status are always re-read since they change without refs moving.
  const logCache = new Map<string, { fingerprint: string; commits: GitCommit[] }>();

  function register(abs: string): RepoEntry {
    for (const [id, entry] of repos) {
      if (entry.path === abs) return { id, path: entry.path, name: entry.name };
    }
    const id = `r${nextId++}`;
    const name = path.basename(abs);
    repos.set(id, { path: abs, name });
    return { id, path: abs, name };
  }

  // `defaultRepo` (LIANA_REPO / Electron launch) is validated lazily on first list.
  let seeded = false;
  async function ensureDefault(): Promise<void> {
    if (seeded) return;
    seeded = true;
    if (!defaultRepo) return;
    const abs = await resolveOpenRepo(defaultRepo);
    if (abs) register(abs);
  }

  async function handle(
    route: string,
    method: string,
    rawBody: string,
    repoId?: string,
  ): Promise<ApiResponse> {
    try {
      if (route === '/repos' && method === 'GET') {
        await ensureDefault();
        const entries: RepoEntry[] = [...repos].map(([id, e]) => ({ id, path: e.path, name: e.name }));
        return { status: 200, body: { repos: entries } };
      }
      if (route === '/open' && method === 'POST') {
        let raw = '';
        try {
          const parsed = JSON.parse(rawBody) as { path?: string };
          raw = typeof parsed.path === 'string' ? parsed.path : '';
        } catch {
          raw = '';
        }
        const abs = await resolveOpenRepo(raw);
        if (!abs) return { status: 400, body: { error: 'Not a git repository' } };
        const entry = register(abs);
        return { status: 200, body: { ok: true, id: entry.id, path: entry.path, name: entry.name } };
      }
      // Every repo-scoped route must name a registered repository.
      const entry = repoId !== undefined ? repos.get(repoId) : undefined;
      if (!entry) return { status: 400, body: { error: 'Unknown repository' } };
      const repoPath = entry.path;
      if (route === '/state' && method === 'GET') {
        const [{ stashes, hidden }, { state, fingerprint: refsPrint }, status, conflicts, submodules] =
          await Promise.all([
            loadStashes(repoPath),
            loadRepoRefs(repoPath),
            loadStatus(repoPath).catch(() => ({ entries: [] as StatusEntry[] })),
            loadConflicts(repoPath).catch(() => [] as ConflictEntry[]),
            loadSubmodules(repoPath).catch(() => [] as SubmoduleInfo[]),
          ]);
        let operation: MergeOperation = { kind: 'none', inProgress: false, onto: null, conflictCount: 0 };
        try {
          operation = await loadMergeState(repoPath, conflicts);
        } catch {
          // Leave the neutral operation when git metadata can't be read.
        }
        const fingerprint = `${refsPrint}\nstash:${[...stashes.keys()].sort().join(',')}`;
        const cacheKey = repoId ?? repoPath;
        const cached = logCache.get(cacheKey);
        let commits: GitCommit[];
        if (cached && cached.fingerprint === fingerprint) {
          commits = cached.commits;
        } else {
          commits = (await loadLog(repoPath, 500, stashes)).filter((c) => !hidden.has(c.hash));
          logCache.set(cacheKey, { fingerprint, commits });
        }
        return {
          status: 200,
          body: { configured: true, repoPath, state, commits, status, conflicts, operation, submodules },
        };
      }
      if (route === '/activity' && method === 'GET') {
        return { status: 200, body: repoActivity(repoPath) };
      }

      if (route === '/conflicts' && method === 'GET') {
        const conflicts = await loadConflicts(repoPath);
        const operation = await loadMergeState(repoPath, conflicts);
        return { status: 200, body: { ok: true, conflicts, operation } };
      }
      if (route === '/conflict-file' && method === 'POST') {
        const { path: filePath } = JSON.parse(rawBody) as { path?: string };
        if (!filePath?.trim()) return { status: 400, body: { error: 'Missing path' } };
        const file = await loadConflictFile(repoPath, filePath.trim());
        return { status: 200, body: { ok: true, file } };
      }
      if (route === '/conflict-resolve' && method === 'POST') {
        const { path: filePath, resolution } = JSON.parse(rawBody) as {
          path?: string;
          resolution?: 'ours' | 'theirs' | 'resolved';
        };
        if (!filePath?.trim()) return { status: 400, body: { error: 'Missing path' } };
        if (resolution !== 'ours' && resolution !== 'theirs' && resolution !== 'resolved') {
          return { status: 400, body: { error: 'Invalid resolution' } };
        }
        await resolveConflict(repoPath, filePath.trim(), resolution);
        return { status: 200, body: { ok: true } };
      }
      if (route === '/conflict-continue' && method === 'POST') {
        const out = await continueOperation(repoPath);
        return { status: 200, body: { ok: true, output: out } };
      }
      if (route === '/conflict-abort' && method === 'POST') {
        const out = await abortOperation(repoPath);
        return { status: 200, body: { ok: true, output: out } };
      }
      if (route === '/conflict-skip' && method === 'POST') {
        const out = await skipOperation(repoPath);
        return { status: 200, body: { ok: true, output: out } };
      }
      if (route === '/submodules' && method === 'GET') {
        const submodules = await loadSubmodules(repoPath);
        return { status: 200, body: { ok: true, submodules } };
      }
      if (route === '/submodule-update' && method === 'POST') {
        const { remote, init } = JSON.parse(rawBody) as { remote?: boolean; init?: boolean };
        const out = await submoduleUpdate(repoPath, { remote, init });
        return { status: 200, body: { ok: true, output: out } };
      }
      if (route === '/submodule-sync' && method === 'POST') {
        const out = await submoduleSync(repoPath);
        return { status: 200, body: { ok: true, output: out } };
      }
      if (route === '/submodule-add' && method === 'POST') {
        const { url, path: dest, branch } = JSON.parse(rawBody) as {
          url?: string;
          path?: string;
          branch?: string;
        };
        if (!url?.trim()) return { status: 400, body: { error: 'Missing URL' } };
        const out = await submoduleAdd(repoPath, url.trim(), dest?.trim(), branch?.trim());
        return { status: 200, body: { ok: true, output: out } };
      }
      if (route === '/submodule-deinit' && method === 'POST') {
        const { path: dest, force } = JSON.parse(rawBody) as { path?: string; force?: boolean };
        if (!dest?.trim()) return { status: 400, body: { error: 'Missing path' } };
        const out = await submoduleDeinit(repoPath, dest.trim(), force === true);
        return { status: 200, body: { ok: true, output: out } };
      }
      if (route === '/submodule-log' && method === 'POST') {
        const { path: subPath } = JSON.parse(rawBody) as { path?: string };
        if (!subPath?.trim()) return { status: 400, body: { error: 'Missing path' } };
        const commits = await loadSubmoduleLog(repoPath, subPath.trim());
        return { status: 200, body: { ok: true, commits } };
      }

      if (route === '/commit' && method === 'POST') {
        const { message, files } = JSON.parse(rawBody) as {
          message?: string;
          files?: unknown;
        };
        if (!message?.trim()) return { status: 400, body: { error: 'Empty commit message' } };
        if (!Array.isArray(files)) return { status: 400, body: { error: 'files must be an array' } };
        const wanted = files.filter((f): f is string => typeof f === 'string');
        if (wanted.length === 0) return { status: 400, body: { error: 'No files selected' } };
        const hash = await createCommit(repoPath, message.trim(), wanted);
        return { status: 200, body: { ok: true, hash } };
      }
      if (route === '/rebase' && method === 'POST') {
        const { onto } = JSON.parse(rawBody) as { onto?: string };
        if (!onto?.trim()) return { status: 400, body: { error: 'Missing branch' } };
        const dirty = await dirtyGuard(repoPath, 'rebasing');
        if (dirty) return { status: 409, body: { error: dirty } };
        const out = await rebaseOnto(repoPath, onto.trim());
        return { status: 200, body: { ok: true, output: out } };
      }
      if (route === '/rebase-start' && method === 'POST') {
        if (!INTERACTIVE_REBASE_ENABLED) {
          return { status: 404, body: { error: 'Interactive rebase disabled' } };
        }
        const { onto } = JSON.parse(rawBody) as { onto?: string };
        if (!onto?.trim()) return { status: 400, body: { error: 'Missing branch' } };
        const dirty = await dirtyGuard(repoPath, 'rebasing');
        if (dirty) return { status: 409, body: { error: dirty } };
        const plan = await loadRebasePlan(repoPath, onto.trim());
        return { status: 200, body: { ok: true, onto: plan.onto, items: plan.items } };
      }
      if (route === '/rebase-execute' && method === 'POST') {
        if (!INTERACTIVE_REBASE_ENABLED) {
          return { status: 404, body: { error: 'Interactive rebase disabled' } };
        }
        const { onto, items } = JSON.parse(rawBody) as {
          onto?: string;
          items?: RebaseTodoItem[];
        };
        if (!onto?.trim()) return { status: 400, body: { error: 'Missing branch' } };
        if (!Array.isArray(items) || items.length === 0) {
          return { status: 400, body: { error: 'Empty rebase todo' } };
        }
        const dirty = await dirtyGuard(repoPath, 'rebasing');
        if (dirty) return { status: 409, body: { error: dirty } };
        const out = await executeRebase(repoPath, onto.trim(), items);
        return { status: 200, body: { ok: true, output: out } };
      }
      if (route === '/merge' && method === 'POST') {
        const { ref } = JSON.parse(rawBody) as { ref?: string };
        if (!ref?.trim()) return { status: 400, body: { error: 'Missing ref' } };
        const dirty = await dirtyGuard(repoPath, 'merging');
        if (dirty) return { status: 409, body: { error: dirty } };
        const out = await mergeBranch(repoPath, ref.trim());
        return { status: 200, body: { ok: true, output: out } };
      }
      if (route === '/cherry-pick' && method === 'POST') {
        const { ref, mainline, record } = JSON.parse(rawBody) as {
          ref?: string;
          mainline?: number;
          record?: boolean;
        };
        if (!ref?.trim()) return { status: 400, body: { error: 'Missing ref' } };
        if (mainline !== undefined && (!Number.isInteger(mainline) || mainline < 1)) {
          return { status: 400, body: { error: 'mainline must be a positive integer' } };
        }
        const dirty = await dirtyGuard(repoPath, 'cherry-picking');
        if (dirty) return { status: 409, body: { error: dirty } };
        const out = await cherryPick(repoPath, ref.trim(), { mainline, record });
        return { status: 200, body: { ok: true, output: out } };
      }
      if (route === '/revert' && method === 'POST') {
        const { ref, mainline } = JSON.parse(rawBody) as { ref?: string; mainline?: number };
        if (!ref?.trim()) return { status: 400, body: { error: 'Missing ref' } };
        if (mainline !== undefined && (!Number.isInteger(mainline) || mainline < 1)) {
          return { status: 400, body: { error: 'mainline must be a positive integer' } };
        }
        const dirty = await dirtyGuard(repoPath, 'reverting');
        if (dirty) return { status: 409, body: { error: dirty } };
        const out = await revert(repoPath, ref.trim(), { mainline });
        return { status: 200, body: { ok: true, output: out } };
      }
      if (route === '/commit-diff' && method === 'POST') {
        const { hash } = JSON.parse(rawBody) as { hash?: string };
        if (!hash?.trim()) return { status: 400, body: { error: 'Missing hash' } };
        const files = await commitFiles(repoPath, hash.trim());
        return { status: 200, body: { ok: true, files } };
      }
      if (route === '/commit-file-diff' && method === 'POST') {
        const { hash, path: filePath, oldPath } = JSON.parse(rawBody) as {
          hash?: string;
          path?: string;
          oldPath?: string | null;
        };
        if (!hash?.trim()) return { status: 400, body: { error: 'Missing hash' } };
        if (!filePath?.trim()) return { status: 400, body: { error: 'Missing path' } };
        const patch = await commitPatch(
          repoPath,
          hash.trim(),
          filePath.trim(),
          typeof oldPath === 'string' && oldPath ? oldPath : null,
        );
        return { status: 200, body: { ok: true, patch } };
      }
      if (route === '/worktree-file-diff' && method === 'POST') {
        const { path: filePath, oldPath } = JSON.parse(rawBody) as {
          path?: string;
          oldPath?: string | null;
        };
        if (!filePath?.trim()) return { status: 400, body: { error: 'Missing path' } };
        const patch = await worktreePatch(
          repoPath,
          filePath.trim(),
          typeof oldPath === 'string' && oldPath ? oldPath : null,
        );
        return { status: 200, body: { ok: true, patch } };
      }
      if (route === '/checkout' && method === 'POST') {
        const { branch, remote } = JSON.parse(rawBody) as { branch?: string; remote?: boolean };
        if (!branch?.trim()) return { status: 400, body: { error: 'Missing branch' } };
        await checkoutBranch(repoPath, branch.trim(), remote === true);
        return { status: 200, body: { ok: true } };
      }
      if (route === '/branch-create' && method === 'POST') {
        const { name, ref } = JSON.parse(rawBody) as { name?: string; ref?: string };
        const branch = name?.trim() ?? '';
        if (!validRefName(branch)) return { status: 400, body: { error: 'Invalid branch name' } };
        if (!ref?.trim()) return { status: 400, body: { error: 'Missing start point' } };
        await createBranch(repoPath, branch, ref.trim());
        return { status: 200, body: { ok: true } };
      }
      if (route === '/branch-delete' && method === 'POST') {
        const { name, remote } = JSON.parse(rawBody) as { name?: string; remote?: boolean };
        const branch = name?.trim() ?? '';
        if (!branch) return { status: 400, body: { error: 'Missing branch' } };
        if (remote) await deleteRemoteBranchPush(repoPath, branch);
        else await deleteBranch(repoPath, branch);
        return { status: 200, body: { ok: true } };
      }
      if (route === '/tag-create' && method === 'POST') {
        const { name, ref } = JSON.parse(rawBody) as { name?: string; ref?: string };
        const tag = name?.trim() ?? '';
        if (!validRefName(tag)) return { status: 400, body: { error: 'Invalid tag name' } };
        if (!ref?.trim()) return { status: 400, body: { error: 'Missing start point' } };
        await createTag(repoPath, tag, ref.trim());
        return { status: 200, body: { ok: true } };
      }
      if (route === '/tag-delete' && method === 'POST') {
        const { name } = JSON.parse(rawBody) as { name?: string };
        if (!name?.trim()) return { status: 400, body: { error: 'Missing tag' } };
        await deleteTag(repoPath, name.trim());
        return { status: 200, body: { ok: true } };
      }
      if (route === '/reset' && method === 'POST') {
        const { mode, ref } = JSON.parse(rawBody) as { mode?: ResetMode; ref?: string };
        if (!mode || !RESET_MODES.includes(mode)) {
          return { status: 400, body: { error: 'Invalid reset mode' } };
        }
        if (!ref?.trim()) return { status: 400, body: { error: 'Missing ref' } };
        await resetBranch(repoPath, mode, ref.trim());
        return { status: 200, body: { ok: true } };
      }
      if (route === '/stash' && method === 'POST') {
        const { message, includeUntracked } = JSON.parse(rawBody) as {
          message?: string;
          includeUntracked?: boolean;
        };
        const hash = await createStash(repoPath, message ?? '', includeUntracked === true);
        if (!hash) return { status: 200, body: { ok: true, stashed: false } };
        return { status: 200, body: { ok: true, stashed: true, hash } };
      }
      if (route === '/stash-apply' && method === 'POST') {
        const { hash } = JSON.parse(rawBody) as { hash?: string };
        if (!hash?.trim()) return { status: 400, body: { error: 'Missing stash' } };
        const selector = await resolveStash(repoPath, hash.trim());
        const out = await applyStash(repoPath, selector);
        return { status: 200, body: { ok: true, output: out } };
      }
      if (route === '/stash-drop' && method === 'POST') {
        const { hash } = JSON.parse(rawBody) as { hash?: string };
        if (!hash?.trim()) return { status: 400, body: { error: 'Missing stash' } };
        const selector = await resolveStash(repoPath, hash.trim());
        const out = await dropStash(repoPath, selector);
        return { status: 200, body: { ok: true, output: out } };
      }
      if (route === '/remote-status' && method === 'GET') {
        const status = await loadRemoteStatus(repoPath);
        return { status: 200, body: status };
      }
      if (route === '/push' && method === 'POST') {
        const { remote, branch, force } = JSON.parse(rawBody) as {
          remote?: string;
          branch?: string;
          force?: boolean;
        };
        const out = await pushBranch(repoPath, remote, branch, force === true);
        return { status: 200, body: { ok: true, output: out } };
      }
      if (route === '/pull' && method === 'POST') {
        const { remote, branch } = JSON.parse(rawBody) as { remote?: string; branch?: string };
        const out = await pullBranch(repoPath, remote, branch);
        return { status: 200, body: { ok: true, output: out } };
      }
      if (route === '/remote-test' && method === 'POST') {
        const { remote } = JSON.parse(rawBody) as { remote?: string };
        await testRemote(repoPath, remote ?? '');
        return { status: 200, body: { ok: true } };
      }
      return { status: 404, body: { error: 'Unknown route' } };
    } catch (err) {
      if (err instanceof GitError) {
        return { status: err.status, body: { error: err.stderr || err.message } };
      }
      return { status: 500, body: { error: String(err) } };
    }
  }

  return {
    handle,
  };
}
