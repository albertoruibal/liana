// All git plumbing lives here. Thin wrappers over the git CLI — no native deps.
// Every command runs with -c advice.* settings disabled so stderr stays clean,
// and maxDepth guards the recursion-free code paths below.

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

const UNIT = '\x1f'; // field separator for --pretty format

export async function isGitRepo(repoPath: string): Promise<boolean> {
  try {
    await git(repoPath, ['rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}

/** Parse %D decoration string into typed ref names (HEAD handled separately). */
function parseDecorations(decorated: string, commit: GitCommit): void {
  if (!decorated.trim()) return;
  for (const item of decorated.split(', ').map((s) => s.trim())) {
    if (item === 'HEAD') {
      commit.refs.push({ name: 'HEAD', kind: 'head' });
    } else if (item.startsWith('HEAD -> ')) {
      commit.refs.push({ name: 'HEAD', kind: 'head' });
      const branch = item.slice('HEAD -> '.length).replace(/^refs\/heads\//, '');
      commit.refs.push({ name: branch, kind: 'local' });
    } else if (item.startsWith('tag: ')) {
      commit.refs.push({ name: item.slice('tag: '.length).replace(/^refs\/tags\//, ''), kind: 'tag' });
    } else if (item.startsWith('refs/remotes/')) {
      commit.refs.push({ name: item.slice('refs/remotes/'.length), kind: 'remote' });
    } else if (item.startsWith('refs/heads/')) {
      commit.refs.push({ name: item.slice('refs/heads/'.length), kind: 'local' });
    } else {
      // Short %D falls back to the default remote as "origin/...".
      commit.refs.push({ name: item, kind: item.startsWith('origin/') ? 'remote' : 'local' });
    }
  }
}

export async function loadLog(
  repoPath: string,
  limit = 500,
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
  const out = await git(repoPath, args);
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
export async function loadStashes(
  repoPath: string,
): Promise<{ stashes: Map<string, StashInfo>; hidden: Set<string> }> {
  const fmt = ['%H', '%gd', '%gs', '%ct', '%an', '%P'].join(UNIT);
  const out = await git(repoPath, ['stash', 'list', `--format=${fmt}`]);
  const stashes = new Map<string, StashInfo>();
  const hidden = new Set<string>();
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [hash = '', selector = '', subject = '', ts = '', author = '', parentList = ''] =
      line.split(UNIT);
    if (!hash) continue;
    const parents = parentList ? parentList.split(' ') : [];
    for (const parent of parents.slice(1)) hidden.add(parent);
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
export async function loadRepoRefs(
  repoPath: string,
): Promise<{ state: RepoState; fingerprint: string }> {
  const [symbolicOut, branchOut, nameOut] = await Promise.all([
    git(repoPath, ['rev-parse', '--symbolic-full-name', 'HEAD']).catch(() => ''),
    git(repoPath, ['for-each-ref', '--format=%(refname)%00%(objectname)']),
    git(repoPath, ['basename', '--', repoPath]).catch(() => repoPath),
  ]);

  // "refs/heads/main" when on a branch, "HEAD" when detached
  const symbolic = symbolicOut.trim();
  const detachedHead = !symbolic.startsWith('refs/heads/');
  const headBranch = detachedHead ? null : symbolic.replace(/^refs\/heads\//, '');

  const branches: BranchInfo[] = [];
  for (const line of branchOut.split('\n')) {
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

  const name = nameOut.trim().split('/').pop() || repoPath;
  return {
    state: { name, headBranch, detachedHead, branches },
    // `branchOut` lists every ref (heads, remotes, tags, stash) with its object
    // id, so comparing it catches any ref move. HEAD name covers unborn/detached.
    fingerprint: `${detachedHead ? 'HEAD' : headBranch}\n${branchOut}`,
  };
}

export async function loadRepoState(repoPath: string): Promise<RepoState> {
  return (await loadRepoRefs(repoPath)).state;
}

export async function loadStatus(repoPath: string): Promise<RepoStatus> {
  const out = await git(repoPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const tokens = out.split('\0');
  const entries: StatusEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const line = tokens[i];
    if (!line) continue;
    const xy = line.slice(0, 2);
    const path = line.slice(3);
    if (!path) continue;
    // In -z mode rename/copy entries are `XY <to>\0<from>\0`; the extra
    // `<from>` token is the rename source, not a status line.
    let oldPath: string | null = null;
    if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') {
      if (i + 1 < tokens.length) {
        oldPath = tokens[i + 1] || null;
        i++;
      }
    }
    entries.push({ stagedX: xy[0] ?? ' ', unstagedY: xy[1] ?? ' ', path, oldPath });
  }
  return { entries };
}

/** True when HEAD resolves (false on an unborn branch, e.g. after `git init`). */
export async function headExists(repoPath: string): Promise<boolean> {
  try {
    await git(repoPath, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

/** Number of uncommitted entries in the working tree (staged or unstaged). */
export async function dirtyCount(repoPath: string): Promise<number> {
  return (await loadStatus(repoPath)).entries.length;
}

/** Returns a human error if the tree is dirty, else null. Mirrors dev.ts dirtyGuard. */
export async function dirtyGuard(repoPath: string, op: string): Promise<string | null> {
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
export async function createCommit(
  repoPath: string,
  message: string,
  files: string[],
): Promise<string> {
  const status = await loadStatus(repoPath);
  const selected = new Set(files);
  const toStage = status.entries.filter((e) => selected.has(e.path)).map((e) => e.path);
  const toUnstage = status.entries
    .filter((e) => !selected.has(e.path) && e.stagedX !== ' ' && e.stagedX !== '?')
    .map((e) => e.path);
  if (toUnstage.length > 0) {
    if (await headExists(repoPath)) {
      await git(repoPath, ['reset', '-q', '--', ...toUnstage]);
    } else {
      await git(repoPath, ['rm', '--cached', '-r', '--', ...toUnstage]);
    }
  }
  if (toStage.length > 0) await git(repoPath, ['add', '-A', '--', ...toStage]);
  const out = await git(repoPath, ['commit', '-m', message]);
  const hash = await git(repoPath, ['rev-parse', 'HEAD']);
  if (!out.includes('created') && !hash) throw new GitError('commit produced no hash', out);
  return hash.trim();
}

/** Rebase the current branch onto `onto`. Uncommitted changes are not allowed by git. */
export async function rebaseOnto(repoPath: string, onto: string): Promise<string> {
  const out = await git(repoPath, ['rebase', onto]);
  return out.trim();
}

/** Merge `ref` into the checked-out branch; `--no-edit` keeps git from opening an editor. */
export async function mergeBranch(repoPath: string, ref: string): Promise<string> {
  const out = await git(repoPath, ['merge', '--no-edit', ref]);
  return out.trim();
}

/**
 * Cherry-pick `ref` onto the current branch.
 * `mainline` selects the parent of a merge commit (git -m N);
 * `record` appends "(cherry picked from ...)" to the message (git -x).
 */
export async function cherryPick(
  repoPath: string,
  ref: string,
  opts: { mainline?: number; record?: boolean } = {},
): Promise<string> {
  const args = ['cherry-pick'];
  if (opts.record) args.push('-x');
  if (opts.mainline !== undefined) args.push('-m', String(opts.mainline));
  args.push(ref);
  const out = await git(repoPath, args);
  return out.trim();
}

/**
 * Revert `ref` on the current branch, creating the inverse commit.
 * `--no-edit` keeps git from opening an editor; `mainline` selects the parent
 * of a merge commit (git -m N). A conflict leaves REVERT_HEAD for the banner.
 */
export async function revertCommit(
  repoPath: string,
  ref: string,
  opts: { mainline?: number } = {},
): Promise<string> {
  const args = ['revert', '--no-edit'];
  if (opts.mainline !== undefined) args.push('-m', String(opts.mainline));
  args.push(ref);
  const out = await git(repoPath, args);
  return out.trim();
}

// --- Conflicts (mirrors src/api.ts) ---

/** Resolve a possibly-relative `--git-path` result against the repo's work tree. */
function repoAbs(repoPath: string, gitPath: string): string {
  return path.isAbsolute(gitPath) ? gitPath : path.join(repoPath, gitPath);
}

/** True when the given git metadata path currently exists on disk. */
async function gitPathExists(repoPath: string, name: string): Promise<boolean> {
  try {
    const out = (await git(repoPath, ['rev-parse', '--git-path', name])).trim();
    return fs.existsSync(repoAbs(repoPath, out));
  } catch {
    return false;
  }
}

/** Read a file inside the git dir (e.g. `rebase-merge/onto`), or null when absent. */
async function readGitPath(repoPath: string, name: string): Promise<string | null> {
  try {
    const out = (await git(repoPath, ['rev-parse', '--git-path', name])).trim();
    const abs = repoAbs(repoPath, out);
    return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8').trim() : null;
  } catch {
    return null;
  }
}

/**
 * Merge / rebase / cherry-pick / revert state, read from git's own metadata files
 * (never inferred). `onto` is the commit the operation applies onto when known.
 */
export async function loadMergeState(repoPath: string): Promise<MergeOperation> {
  const [rebaseMerge, rebaseApply, mergeHead, cherryHead, revertHead, conflicts] = await Promise.all([
    gitPathExists(repoPath, 'rebase-merge'),
    gitPathExists(repoPath, 'rebase-apply'),
    gitPathExists(repoPath, 'MERGE_HEAD'),
    gitPathExists(repoPath, 'CHERRY_PICK_HEAD'),
    gitPathExists(repoPath, 'REVERT_HEAD'),
    loadConflicts(repoPath),
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
  return { kind, inProgress: kind !== 'none', onto, conflictCount: conflicts.length };
}

/** Unmerged index entries (`git ls-files -u`), parsed into conflict records. */
export async function loadConflicts(repoPath: string): Promise<ConflictEntry[]> {
  const out = await git(repoPath, ['ls-files', '-u', '-z']);
  return parseUnmerged(out);
}

/** A blob or gitlink id as text, or null when the path has no such index stage. */
async function readStage(repoPath: string, stage: number, filePath: string): Promise<string | null> {
  try {
    const out = await git(repoPath, ['show', `:${stage}:${filePath}`]);
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
export async function loadConflictFile(repoPath: string, filePath: string): Promise<ConflictFile> {
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
export async function resolveConflict(
  repoPath: string,
  filePath: string,
  resolution: 'ours' | 'theirs' | 'resolved',
): Promise<void> {
  if (resolution === 'resolved') {
    await git(repoPath, ['add', '--', filePath]);
    return;
  }
  try {
    await git(repoPath, ['checkout', `--${resolution}`, '--', filePath]);
    await git(repoPath, ['add', '-A', '--', filePath]);
  } catch {
    // `git checkout --<side>` only fails when that side has no version of the path
    // (a delete/modify conflict), so choosing it means removing the file.
    await git(repoPath, ['rm', '-f', '-q', '--', filePath]).catch(() => '');
  }
}

/** Continue the in-progress operation without opening an editor. */
export async function continueOperation(repoPath: string): Promise<string> {
  const { kind } = await loadMergeState(repoPath);
  if (kind === 'none') throw new GitError('No operation to continue', '', 400);
  if (kind === 'revert') {
    return (await git(repoPath, ['commit', '--no-edit'])).trim();
  }
  return (await git(repoPath, ['-c', 'core.editor=true', kind, '--continue'])).trim();
}

/** Abort the in-progress operation, restoring the pre-operation state. */
export async function abortOperation(repoPath: string): Promise<string> {
  const { kind } = await loadMergeState(repoPath);
  if (kind === 'none') throw new GitError('No operation to abort', '', 400);
  return (await git(repoPath, [kind, '--abort'])).trim();
}

/** Skip the current patch of an in-progress rebase, cherry-pick, or revert. */
export async function skipOperation(repoPath: string): Promise<string> {
  const { kind } = await loadMergeState(repoPath);
  if (kind === 'none') throw new GitError('No operation to skip', '', 400);
  if (kind === 'merge') throw new GitError('Cannot skip a merge', 'Abort the merge instead', 400);
  return (await git(repoPath, [kind, '--skip'])).trim();
}

// --- Submodules (mirrors src/api.ts) ---

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
export async function loadSubmodules(repoPath: string): Promise<SubmoduleInfo[]> {
  const cfgOut = await git(repoPath, ['config', '-f', '.gitmodules', '--get-regexp', '.']).catch(() => '');
  const mods = parseGitmodules(cfgOut);
  const statusOut = await git(repoPath, ['submodule', 'status', '--recursive']).catch(() => '');
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
      try {
        const out = (await git(repoPath, ['ls-files', '--stage', '--', entry.path])).trim();
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
  return (await git(repoPath, ['submodule', ...args], NET_ENV)).trim();
}

/** `git submodule update`; `--init` initializes, `--remote` tracks the remote branch. */
export async function submoduleUpdate(
  repoPath: string,
  opts: { remote?: boolean; init?: boolean } = {},
): Promise<string> {
  const args = ['update'];
  if (opts.init) args.push('--init');
  if (opts.remote) args.push('--remote');
  return submoduleNetwork(repoPath, args);
}

/** `git submodule sync --recursive`: update the submodule URLs from `.gitmodules`. */
export async function submoduleSync(repoPath: string): Promise<string> {
  return submoduleNetwork(repoPath, ['sync', '--recursive']);
}

/** `git submodule add`: clone `url` into `path` (defaults to a derived directory). */
export async function submoduleAdd(
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
export async function submoduleDeinit(
  repoPath: string,
  dest: string,
  force = false,
): Promise<string> {
  const args = ['deinit'];
  if (force) args.push('-f');
  args.push('--', dest);
  return (await git(repoPath, ['submodule', ...args])).trim();
}

/**
 * History of a submodule, read by running the graph's `git log` inside the
 * submodule's own repository. `subPath` is resolved under `repoPath` and must not
 * escape it.
 */
export async function loadSubmoduleLog(
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
export async function commitFiles(repoPath: string, hash: string): Promise<CommitFile[]> {
  const [nameStatusOut, numstatOut, rawOut] = await Promise.all([
    git(repoPath, ['show', '--name-status', '-z', '--format=', '--find-renames', '--first-parent', hash]),
    git(repoPath, ['show', '--numstat', '-z', '--format=', '--find-renames', '--first-parent', hash]),
    git(repoPath, ['show', '--raw', '-z', '--format=', '--find-renames', '--first-parent', hash]),
  ]);
  return parseCommitFiles(nameStatusOut, numstatOut, rawOut);
}

/** Unified diff for one file of a commit; `oldPath` included so renames diff as renames. */
export async function commitPatch(
  repoPath: string,
  hash: string,
  filePath: string,
  oldPath: string | null,
): Promise<string> {
  const paths = oldPath && oldPath !== filePath ? [oldPath, filePath] : [filePath];
  return (
    await git(repoPath, [
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
export async function worktreePatch(
  repoPath: string,
  filePath: string,
  oldPath: string | null,
): Promise<string> {
  const paths = oldPath && oldPath !== filePath ? [oldPath, filePath] : [filePath];
  const base = (await headExists(repoPath)) ? 'HEAD' : EMPTY_TREE;
  try {
    const out = await git(repoPath, [
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
    await git(repoPath, ['ls-files', '--error-unmatch', '--', filePath]);
    return '';
  } catch {
    // Path is untracked — compare it against /dev/null below.
  }
  try {
    return (
      await git(repoPath, ['diff', '--no-color', '--no-index', '--', '/dev/null', filePath])
    ).trim();
  } catch (err) {
    // `--no-index` exits 1 whenever the files differ, and git surfaces that
    // stdout through GitError.stderr. A real failure (missing path) has none.
    if (err instanceof GitError && err.stderr.trim().startsWith('diff --git')) {
      return err.stderr.trim();
    }
    return '';
  }
}

// --- Interactive rebase (mirrors dev.ts) ---

const REBASE_ACTIONS: readonly RebaseAction[] = ['pick', 'drop', 'reword', 'squash'];

export interface RebasePlanItem {
  hash: string;
  subject: string;
  author: string;
  timestamp: number;
}

async function resolveCommit(repoPath: string, ref: string): Promise<string> {
  return (await git(repoPath, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
}

/** Commits between `onto` and HEAD, oldest first, that an interactive rebase would replay. */
export async function loadRebasePlan(
  repoPath: string,
  onto: string,
): Promise<{ onto: string; items: RebasePlanItem[] }> {
  const ontoHash = await resolveCommit(repoPath, onto);
  const fmt = ['%H', '%s', '%an', '%at'].join('\x1f');
  const out = await git(repoPath, [
    'log',
    '--reverse',
    `--pretty=format:${fmt}`,
    `${ontoHash}..HEAD`,
  ]);
  const items: RebasePlanItem[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [hash = '', subject = '', author = '', ts = ''] = line.split('\x1f');
    items.push({ hash, subject, author, timestamp: Number(ts) || 0 });
  }
  return { onto: ontoHash, items };
}

/** Run an interactive rebase from a generated todo list without opening an editor. */
export async function executeRebase(
  repoPath: string,
  onto: string,
  items: RebaseTodoItem[],
): Promise<string> {
  if (!INTERACTIVE_REBASE_ENABLED) throw new GitError('Interactive rebase disabled', '');
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
    fs.writeFileSync(
      seqEditor,
      `#!/bin/sh\ncat > "$1" <<'LIANA_TODO_EOF'\n${todoLines.join('\n')}\nLIANA_TODO_EOF\n`,
      { mode: 0o755 },
    );

    return (
      await git(repoPath, ['-c', 'core.editor=true', 'rebase', '-i', plan.onto], {
        GIT_SEQUENCE_EDITOR: seqEditor,
      })
    ).trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- Branches and tags (mirrors src/api.ts) ---

const REF_NAME_RE = /^[^\s~^:?*[\\]+$/;

/** Reject names git would misinterpret as an option, a range, or a path. */
export function validRefName(name: string): boolean {
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

/** Local branch name a remote-tracking ref should check out as, or throw. */
function remoteBranchLocalName(name: string): string {
  const m = /^([^/]+)\/(.+)$/.exec(name);
  const branch = m?.[2] ?? '';
  if (!m || !m[1] || !branch || branch === 'HEAD' || !validRefName(branch)) {
    throw new GitError(`Not a remote branch: ${name}`, '');
  }
  return branch;
}

/**
 * Check out a branch. Local names are checked out directly; for a remote-tracking
 * ref like `origin/feature` this creates (or reuses) the local `feature` branch and
 * tracks the remote — purely local, no fetch.
 */
export async function checkoutBranch(repoPath: string, name: string, remote = false): Promise<void> {
  if (!remote) {
    await git(repoPath, ['checkout', name]);
    return;
  }
  const branchName = remoteBranchLocalName(name);
  const exists = await git(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`])
    .then(() => true)
    .catch(() => false);
  if (exists) {
    await git(repoPath, ['checkout', branchName]);
  } else {
    await git(repoPath, ['checkout', '-b', branchName, '--track', name]);
  }
}

/** Create a branch and check it out (`git checkout -b`); fails if it exists. */
export async function createBranch(repoPath: string, name: string, ref: string): Promise<void> {
  await git(repoPath, ['checkout', '-b', name, ref]);
}

/** Force-delete a local branch (`git branch -D`). */
export async function deleteBranch(repoPath: string, name: string): Promise<void> {
  await git(repoPath, ['branch', '-D', name]);
}

/** Delete the branch on the remote and its tracking ref (`git push --delete`). */
export async function deleteRemoteBranchPush(repoPath: string, name: string): Promise<void> {
  const m = /^([^/]+)\/(.+)$/.exec(name);
  if (!m || !m[1] || !m[2]) throw new GitError(`Not a remote branch: ${name}`, '');
  await git(repoPath, ['push', m[1], '--delete', m[2]], { GIT_TERMINAL_PROMPT: '0' });
}

// --- Remotes: push / pull / login (network) (mirrors src/api.ts) ---

/** `GIT_TERMINAL_PROMPT=0` so a missing credential fails fast instead of hanging. */
const NET_ENV: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: '0' };

/** Current branch name, or null when HEAD is detached / unborn. */
export async function currentBranch(repoPath: string): Promise<string | null> {
  try {
    const name = (await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    return name && name !== 'HEAD' ? name : null;
  } catch {
    return null;
  }
}

/** Configured remotes with their fetch URLs, de-duplicated by name. */
export async function loadRemotes(
  repoPath: string,
): Promise<Array<{ name: string; url: string }>> {
  const names = (await git(repoPath, ['remote'])).split('\n').map((s) => s.trim()).filter(Boolean);
  const remotes: Array<{ name: string; url: string }> = [];
  for (const name of names) {
    let url = '';
    try {
      url = (await git(repoPath, ['remote', 'get-url', name])).trim();
    } catch {
      url = '';
    }
    remotes.push({ name, url });
  }
  return remotes;
}

/** Upstream ref of the checked-out branch, e.g. "origin/main", or null when unset. */
export async function upstreamRef(repoPath: string): Promise<string | null> {
  try {
    const out = (
      await git(repoPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
    ).trim();
    return out || null;
  } catch {
    return null;
  }
}

export async function loadRemoteStatus(repoPath: string): Promise<RemoteStatus> {
  const [branch, remotes, upstream, helper] = await Promise.all([
    currentBranch(repoPath),
    loadRemotes(repoPath).catch(() => []),
    upstreamRef(repoPath),
    git(repoPath, ['config', '--get', 'credential.helper']).catch(() => ''),
  ]);
  let ahead = 0;
  let behind = 0;
  if (upstream) {
    try {
      const out = (
        await git(repoPath, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`])
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
export async function pushBranch(
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
      return (await git(repoPath, ['push', ...lease, '-u', target, branchName], NET_ENV)).trim();
    }
    return (await git(repoPath, ['push', ...lease, target], NET_ENV)).trim();
  }

  if (await upstreamRef(repoPath)) {
    return (await git(repoPath, ['push', ...lease], NET_ENV)).trim();
  }
  if (remotes.length === 0) {
    throw new GitError('No remote configured', 'Add a remote with `git remote add` first', 400);
  }
  if (remotes.length > 1) {
    throw new GitError('Multiple remotes configured', 'Pick a remote to push to', 400);
  }
  const only = remotes[0]!;
  return (await git(repoPath, ['push', ...lease, '-u', only.name, branchName], NET_ENV)).trim();
}

/**
 * Pull the checked-out branch (merge). Local changes are allowed through; git
 * itself refuses (and the caller surfaces its stderr) when they'd be overwritten.
 */
export async function pullBranch(
  repoPath: string,
  remote?: string,
  branch?: string,
): Promise<string> {
  const target = remote?.trim() || '';
  if (target) {
    const branchName = branch?.trim() || (await currentBranch(repoPath));
    if (!branchName)
      throw new GitError('Cannot pull: detached HEAD', 'Check out a branch first', 400);
    return (await git(repoPath, ['pull', target, branchName], NET_ENV)).trim();
  }
  if (!(await upstreamRef(repoPath))) {
    throw new GitError('No upstream configured', 'Push the branch first to set its upstream', 400);
  }
  return (await git(repoPath, ['pull'], NET_ENV)).trim();
}

/** `git ls-remote` a remote to verify connectivity and credentials. */
export async function testRemote(repoPath: string, remote: string): Promise<void> {
  const name = remote.trim();
  if (!name) throw new GitError('Missing remote', 'Pick a configured remote', 400);
  const remotes = await loadRemotes(repoPath);
  if (!remotes.some((r) => r.name === name))
    throw new GitError(`Unknown remote: ${name}`, 'Pick a configured remote', 400);
  await git(repoPath, ['ls-remote', '--exit-code', name], NET_ENV);
}

/** Create a lightweight tag at `ref` (`git tag`). */
export async function createTag(repoPath: string, name: string, ref: string): Promise<void> {
  await git(repoPath, ['tag', name, ref]);
}

/** Delete a tag (`git tag -d`). */
export async function deleteTag(repoPath: string, name: string): Promise<void> {
  await git(repoPath, ['tag', '-d', name]);
}

// --- Reset (mirrors src/api.ts) ---

/** Move HEAD (and the checked-out branch) to `ref`, discarding changes for hard. */
export async function resetBranch(repoPath: string, mode: ResetMode, ref: string): Promise<void> {
  await git(repoPath, ['reset', `--${mode}`, ref]);
}

// --- Stash (mirrors src/api.ts) ---

/** Resolve a stash WIP commit hash to its current reflog selector. */
export async function resolveStash(repoPath: string, hash: string): Promise<string> {
  const { stashes } = await loadStashes(repoPath);
  const info = stashes.get(hash);
  if (!info) throw new GitError(`Unknown stash ${hash}`, 'No such stash');
  return info.selector;
}

/** `git stash push`; `includeUntracked` maps to `-u`. Returns the WIP hash, or '' when clean. */
export async function createStash(
  repoPath: string,
  message: string,
  includeUntracked: boolean,
): Promise<string> {
  const m = message.trim();
  const args = ['stash', 'push'];
  if (m) args.push('-m', m);
  if (includeUntracked) args.push('-u');
  const out = await git(repoPath, args);
  if (/No local changes to save/i.test(out)) return '';
  const { stashes } = await loadStashes(repoPath);
  const first = stashes.values().next().value as StashInfo | undefined;
  return first?.hash ?? '';
}

/** `git stash apply` a selector; keeps the stash in place. */
export async function applyStash(repoPath: string, selector: string): Promise<string> {
  return (await git(repoPath, ['stash', 'apply', selector])).trim();
}

/** `git stash drop` a selector; removes one stash entry. */
export async function dropStash(repoPath: string, selector: string): Promise<string> {
  return (await git(repoPath, ['stash', 'drop', selector])).trim();
}