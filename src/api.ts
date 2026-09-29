// Transport-agnostic git backend: all /api route logic, no HTTP framework.
// Node-only — never import this from the renderer bundle (see AGENTS.md).
// `dev.ts` wraps `handleRequest` in Vite Connect middleware; `electron/server.ts`
// wraps it in node:http. Wrapper changes must be mirrored in `src/git.ts`.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { INTERACTIVE_REBASE_ENABLED } from './config';
import { parseCommitFiles } from './commit-files';
import type {
  BranchInfo,
  CommitFile,
  GitCommit,
  GitRef,
  RebaseAction,
  RebaseTodoItem,
  RemoteStatus,
  RepoState,
  RepoStatus,
  ResetMode,
  StashInfo,
  StatusEntry,
} from './types';

const UNIT = '\x1f';

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
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: repoPath,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C', ...extraEnv },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => reject(new GitError(`git failed to start: ${err.message}`, stderr)));
    child.on('close', (code) => {
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

async function loadRepoState(repoPath: string): Promise<RepoState> {
  const [branchOut, symbolicOut] = await Promise.all([
    gitRun(repoPath, ['for-each-ref', '--format=%(refname)%00%(objectname)']),
    gitRun(repoPath, ['rev-parse', '--symbolic-full-name', 'HEAD']).catch(() => ''),
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

  const name = path.basename(repoPath);
  return { name, headBranch, detachedHead, branches };
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
    entries.push({ stagedX: xy[0] ?? ' ', unstagedY: xy[1] ?? ' ', path: p });
    // In -z mode rename/copy entries are `XY <to>\0<from>\0`; the extra
    // `<from>` token is not a status line, so skip it.
    if ((xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') && i + 1 < tokens.length) {
      i++;
    }
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
 * Files changed by a commit, with per-file line counts. Uses `--first-parent` so a
 * merge commit reports the changes it introduces relative to its mainline parent,
 * matching `git show`.
 */
async function commitFiles(repoPath: string, hash: string): Promise<CommitFile[]> {
  const [nameStatusOut, numstatOut] = await Promise.all([
    gitRun(repoPath, ['show', '--name-status', '-z', '--format=', '--find-renames', '--first-parent', hash]),
    gitRun(repoPath, ['show', '--numstat', '-z', '--format=', '--find-renames', '--first-parent', hash]),
  ]);
  return parseCommitFiles(nameStatusOut, numstatOut);
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
        const [{ stashes, hidden }, state, status] = await Promise.all([
          loadStashes(repoPath),
          loadRepoState(repoPath),
          loadStatus(repoPath).catch(() => ({ entries: [] as StatusEntry[] })),
        ]);
        const log = (await loadLog(repoPath, 500, stashes)).filter((c) => !hidden.has(c.hash));
        return {
          status: 200,
          body: { configured: true, repoPath, state, commits: log, status },
        };
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
