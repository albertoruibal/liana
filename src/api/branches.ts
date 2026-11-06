// Branch and tag management. Node-only. Mirrored by src/git/branches.ts.

import { gitRun, GitError, NET_ENV } from './exec';
import { dirtyCount } from './repo';
import { createStash, dropStash, applyStash, resolveStash } from './stash';
import type { CheckoutResult } from '../types';

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

/**
 * Check out a branch. Local names are checked out directly; for a remote-tracking
 * ref like `origin/feature` this creates (or reuses) the local `feature` branch and
 * tracks the remote — purely local, no fetch. Local changes (including untracked
 * files) are stashed for the switch and reapplied afterwards; if they cannot be
 * reapplied the stash is kept and reported in `warning`.
 */
export async function checkoutBranch(
  repoPath: string,
  name: string,
  remote = false,
): Promise<CheckoutResult> {
  if ((await dirtyCount(repoPath)) === 0) {
    await switchBranch(repoPath, name, remote);
    return { stashed: false, restored: false, warning: null };
  }

  const hash = await createStash(repoPath, `liana: auto-stash before checkout ${name}`, true);
  if (!hash) {
    await switchBranch(repoPath, name, remote);
    return { stashed: false, restored: false, warning: null };
  }
  const selector = await resolveStash(repoPath, hash);

  try {
    await switchBranch(repoPath, name, remote);
  } catch (err) {
    try {
      await applyStash(repoPath, selector, true);
      await dropStash(repoPath, selector);
    } catch (restoreErr) {
      const detail = err instanceof GitError ? err.stderr || err.message : String(err);
      const restoreDetail =
        restoreErr instanceof GitError ? restoreErr.stderr || restoreErr.message : String(restoreErr);
      throw new GitError(
        `${detail}\nThe automatic stash could not be restored (${selector}): ${restoreDetail}`,
        err instanceof GitError ? err.stderr : '',
      );
    }
    throw err;
  }

  try {
    await applyStash(repoPath, selector, true);
  } catch (err) {
    const detail = err instanceof GitError ? err.stderr || err.message : String(err);
    return {
      stashed: true,
      restored: false,
      warning:
        `Switched to ${name}, but the automatic stash could not be restored: ${detail}. ` +
        `Your changes are saved in ${selector}.`,
    };
  }
  try {
    await dropStash(repoPath, selector);
  } catch (err) {
    const detail = err instanceof GitError ? err.stderr || err.message : String(err);
    return {
      stashed: true,
      restored: true,
      warning:
        `Switched to ${name} and restored your changes, but the stash entry ${selector} ` +
        `could not be dropped: ${detail}.`,
    };
  }
  return { stashed: true, restored: true, warning: null };
}

/** Perform the actual checkout without touching a dirty working tree. */
async function switchBranch(repoPath: string, name: string, remote: boolean): Promise<void> {
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
export function remoteBranchLocalName(name: string): string {
  const m = /^([^/]+)\/(.+)$/.exec(name);
  const branch = m?.[2] ?? '';
  if (!m || !m[1] || !branch || branch === 'HEAD' || !validRefName(branch)) {
    throw new GitError(`Not a remote branch: ${name}`, '');
  }
  return branch;
}

/** `git branch -b` plus checkout; fails if the branch already exists. */
export async function createBranch(repoPath: string, name: string, ref: string): Promise<void> {
  await gitRun(repoPath, ['checkout', '-b', name, ref]);
}

export async function deleteBranch(repoPath: string, name: string): Promise<void> {
  await gitRun(repoPath, ['branch', '-D', name]);
}

/** True when a local or remote-tracking ref exists. */
async function refExists(repoPath: string, ref: string): Promise<boolean> {
  return gitRun(repoPath, ['show-ref', '--verify', '--quiet', ref])
    .then(() => true)
    .catch(() => false);
}

/** Detailed text for a git failure, preferring git's stderr. */
function errorDetail(err: unknown): string {
  return err instanceof GitError ? err.stderr || err.message : String(err);
}

/** Local branches whose upstream is `upstream` (e.g. `origin/feature`). */
async function localBranchesTracking(repoPath: string, upstream: string): Promise<string[]> {
  const out = await gitRun(repoPath, [
    'for-each-ref',
    '--format=%(refname:short)%00%(upstream:short)',
    'refs/heads',
  ]);
  const result: string[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [name = '', tracked = ''] = line.split('\0');
    if (name && tracked === upstream) result.push(name);
  }
  return result;
}

/** Rename a local branch (`git branch -m`); its config and upstream are kept. */
export async function renameBranch(repoPath: string, name: string, newName: string): Promise<void> {
  if (name === newName) return;
  await gitRun(repoPath, ['branch', '-m', name, newName]);
}

/**
 * Rename a remote branch. The local branch named after it (when it tracks the
 * old ref) is renamed too, then the new remote branch is pushed from the old
 * remote-tracking tip, the old remote branch is deleted, and every local branch
 * that tracked it is pointed at the new upstream. Git has no atomic remote
 * branch rename, so a failed delete is reported after the new branch exists.
 */
export async function renameRemoteBranch(
  repoPath: string,
  name: string,
  newName: string,
): Promise<void> {
  const m = /^([^/]+)\/(.+)$/.exec(name);
  const remote = m?.[1] ?? '';
  const oldBranch = m?.[2] ?? '';
  if (!remote || !oldBranch || oldBranch === 'HEAD') {
    throw new GitError(`Not a remote branch: ${name}`, '');
  }
  if (oldBranch === newName) return;

  const oldRef = `refs/remotes/${remote}/${oldBranch}`;
  const newRef = `refs/remotes/${remote}/${newName}`;
  if (await refExists(repoPath, newRef)) {
    throw new GitError(`Remote branch already exists: ${remote}/${newName}`, '', 400);
  }

  const tracking = await localBranchesTracking(repoPath, `${remote}/${oldBranch}`);
  const localToRename = tracking.includes(oldBranch) ? oldBranch : null;
  if (localToRename && (await refExists(repoPath, `refs/heads/${newName}`))) {
    throw new GitError(`Local branch already exists: ${newName}`, '', 400);
  }

  // Rename the local side first: a failure here (collision, another worktree)
  // leaves the remote untouched. A failed push rolls the local rename back.
  if (localToRename) await renameBranch(repoPath, localToRename, newName);

  try {
    await gitRun(repoPath, ['push', remote, `${oldRef}:refs/heads/${newName}`], NET_ENV);
  } catch (err) {
    if (localToRename) {
      try {
        await renameBranch(repoPath, newName, localToRename);
      } catch (rollbackErr) {
        throw new GitError(
          `${errorDetail(err)}\nThe local branch was renamed to ${newName} but could not be ` +
            `renamed back: ${errorDetail(rollbackErr)}`,
          err instanceof GitError ? err.stderr : '',
        );
      }
    }
    throw err;
  }

  const problems: string[] = [];
  let stderr = '';
  try {
    await gitRun(repoPath, ['push', remote, '--delete', oldBranch], NET_ENV);
  } catch (err) {
    problems.push(`the old remote branch could not be deleted: ${errorDetail(err)}`);
    if (err instanceof GitError) stderr = err.stderr;
  }

  for (const local of tracking) {
    const target = local === localToRename ? newName : local;
    try {
      await gitRun(repoPath, ['config', `branch.${target}.remote`, remote]);
      await gitRun(repoPath, ['config', `branch.${target}.merge`, `refs/heads/${newName}`]);
    } catch (err) {
      problems.push(`the upstream of ${target} could not be updated: ${errorDetail(err)}`);
      if (!stderr && err instanceof GitError) stderr = err.stderr;
    }
  }

  if (problems.length > 0) {
    throw new GitError(
      `Renamed ${name} to ${remote}/${newName}, but ${problems.join('; ')}`,
      stderr,
    );
  }
}

/** Delete the branch on the remote and its tracking ref (`git push --delete`). */
export async function deleteRemoteBranchPush(repoPath: string, name: string): Promise<void> {
  const m = /^([^/]+)\/(.+)$/.exec(name);
  if (!m || !m[1] || !m[2]) throw new GitError(`Not a remote branch: ${name}`, '');
  await gitRun(repoPath, ['push', m[1], '--delete', m[2]], NET_ENV);
}

/** Create a lightweight tag at `ref` (`git tag`). */
export async function createTag(repoPath: string, name: string, ref: string): Promise<void> {
  await gitRun(repoPath, ['tag', name, ref]);
}

/** Delete a tag (`git tag -d`). */
export async function deleteTag(repoPath: string, name: string): Promise<void> {
  await gitRun(repoPath, ['tag', '-d', name]);
}
