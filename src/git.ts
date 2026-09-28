// All git plumbing lives here. Thin wrappers over the git CLI — no native deps.
// Every command runs with -c advice.* settings disabled so stderr stays clean,
// and maxDepth guards the recursion-free code paths below.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { INTERACTIVE_REBASE_ENABLED } from './config';
import type {
  BranchInfo,
  GitCommit,
  RebaseAction,
  RebaseTodoItem,
  RepoState,
  RepoStatus,
  ResetMode,
  StashInfo,
  StatusEntry,
} from './types';

export class GitError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
  ) {
    super(message);
  }
}

/** Run a git command in `repoPath`; resolves stdout, rejects GitError on nonzero exit. */
export function git(
  repoPath: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<string> {
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
    child.on('error', (err) => reject(new GitError(`git failed to start: ${err.message}`, stderr)));
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new GitError(`git ${args[0]} failed (exit ${code})`, stderr.trim()));
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

export async function loadRepoState(repoPath: string): Promise<RepoState> {
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
  return { name, headBranch, detachedHead, branches };
}

export async function loadStatus(repoPath: string): Promise<RepoStatus> {
  const out = await git(repoPath, ['status', '--porcelain=v1', '--untracked-files=all']);
  const entries: StatusEntry[] = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const xy = line.slice(0, 2);
    const path = line.slice(3);
    if (!path) continue;
    entries.push({ stagedX: xy[0] ?? ' ', unstagedY: xy[1] ?? ' ', path });
  }
  return { entries };
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
 * Create a commit. When `stageAll` is true, stage every change first (`add -A`);
 * otherwise commit only what is already staged. Returns the new commit hash.
 */
export async function createCommit(
  repoPath: string,
  message: string,
  stageAll: boolean,
): Promise<string> {
  if (stageAll) await git(repoPath, ['add', '-A']);
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

/** `git show --stat` for a single commit, as text. */
export async function commitDiffStat(repoPath: string, hash: string): Promise<string> {
  return (await git(repoPath, ['show', '--stat', '--format=%h %s (%an)', hash])).trim();
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

/** List local branches with head marker, for the checkout menu. */
export async function checkoutBranch(repoPath: string, name: string): Promise<void> {
  await git(repoPath, ['checkout', name]);
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
  await git(repoPath, ['push', m[1], '--delete', m[2]]);
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