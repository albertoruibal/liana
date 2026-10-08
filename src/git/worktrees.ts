// Browser-side mirror of src/api/worktrees.ts: worktree reads and local management.

import fs from 'node:fs';
import { git, GitError } from './exec';
import { validRefName } from './branches';
import type { WorktreeInfo } from '../types';

/** Canonical path for comparison, falling back to `path.resolve` when absent. */
function realPath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

/**
 * Configured working trees (`git worktree list --porcelain`). The first record is
 * the main working tree; `isCurrent` marks the one matching the requested repo.
 * A prunable worktree's directory no longer exists, so its path can't be
 * realpath'd — compare the raw path then too.
 */
export async function loadWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
  const out = await git(repoPath, ['worktree', 'list', '--porcelain']);
  const current = realPath(repoPath);
  const worktrees: WorktreeInfo[] = [];
  for (const block of out.split('\n\n')) {
    if (!block.trim()) continue;
    let path = '';
    let head: string | null = null;
    let branchRef: string | null = null;
    let detached = false;
    let bare = false;
    let locked = false;
    let lockReason: string | null = null;
    let prunable = false;
    let prunableReason: string | null = null;
    for (const raw of block.split('\n')) {
      const line = raw.trimEnd();
      if (!line) continue;
      if (line.startsWith('worktree ')) {
        path = line.slice('worktree '.length);
      } else if (line.startsWith('HEAD ')) {
        head = line.slice('HEAD '.length);
      } else if (line.startsWith('branch ')) {
        branchRef = line.slice('branch '.length).replace(/^refs\/heads\//, '');
      } else if (line === 'detached') {
        detached = true;
      } else if (line === 'bare') {
        bare = true;
      } else if (line === 'locked') {
        locked = true;
      } else if (line.startsWith('locked ')) {
        locked = true;
        lockReason = line.slice('locked '.length);
      } else if (line === 'prunable') {
        prunable = true;
      } else if (line.startsWith('prunable ')) {
        prunable = true;
        prunableReason = line.slice('prunable '.length);
      }
    }
    if (!path) continue;
    const info: WorktreeInfo = {
      path,
      head,
      branch: branchRef,
      detached,
      bare,
      locked,
      lockReason,
      prunable,
      prunableReason,
      isMain: worktrees.length === 0,
      isCurrent: realPath(path) === current,
    };
    worktrees.push(info);
  }
  return worktrees;
}

/** `git worktree add <path> -b <branch> <ref>`: create and check out a new branch. */
export async function worktreeAdd(
  repoPath: string,
  path: string,
  branch: string,
  ref: string,
): Promise<string> {
  if (!validRefName(branch)) {
    throw new GitError(`Invalid branch name: ${branch}`, 'Use a valid branch name', 400);
  }
  return (await git(repoPath, ['worktree', 'add', path, '-b', branch, ref])).trim();
}

/** `git worktree remove [--force] <path>`. */
export async function worktreeRemove(
  repoPath: string,
  path: string,
  force = false,
): Promise<string> {
  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(path);
  return (await git(repoPath, args)).trim();
}

/** `git worktree lock [--reason <reason>] <path>`. */
export async function worktreeLock(
  repoPath: string,
  path: string,
  reason?: string,
): Promise<string> {
  const args = ['worktree', 'lock'];
  if (reason?.trim()) args.push('--reason', reason.trim());
  args.push(path);
  return (await git(repoPath, args)).trim();
}

/** `git worktree unlock <path>`. */
export async function worktreeUnlock(repoPath: string, path: string): Promise<string> {
  return (await git(repoPath, ['worktree', 'unlock', path])).trim();
}

/** `git worktree move <path> <to>`. */
export async function worktreeMove(repoPath: string, path: string, to: string): Promise<string> {
  return (await git(repoPath, ['worktree', 'move', path, to])).trim();
}

/** `git worktree prune`: drop stale worktree records. */
export async function worktreePrune(repoPath: string): Promise<string> {
  return (await git(repoPath, ['worktree', 'prune'])).trim();
}
