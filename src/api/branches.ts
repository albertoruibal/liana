// Branch and tag management. Node-only. Mirrored by src/git/branches.ts.

import { gitRun, GitError, NET_ENV } from './exec';

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
 * tracks the remote — purely local, no fetch.
 */
export async function checkoutBranch(repoPath: string, name: string, remote = false): Promise<void> {
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
