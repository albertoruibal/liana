// Remotes: push / pull / connectivity checks (network). Node-only.
// Mirrored by src/git/remotes.ts.

import { gitRun, GitError, NET_ENV } from './exec';
import type { RemoteStatus } from '../types';

/** Current branch name, or null when HEAD is detached / unborn. */
export async function currentBranch(repoPath: string): Promise<string | null> {
  try {
    const name = (await gitRun(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    return name && name !== 'HEAD' ? name : null;
  } catch {
    return null;
  }
}

/** Configured remotes with their fetch URLs, de-duplicated by name. */
export async function loadRemotes(repoPath: string): Promise<Array<{ name: string; url: string }>> {
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
export async function upstreamRef(repoPath: string): Promise<string | null> {
  try {
    const out = (
      await gitRun(repoPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
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
export async function pullBranch(repoPath: string, remote?: string, branch?: string): Promise<string> {
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
export async function testRemote(repoPath: string, remote: string): Promise<void> {
  const name = remote.trim();
  if (!name) throw new GitError('Missing remote', 'Pick a configured remote', 400);
  const remotes = await loadRemotes(repoPath);
  if (!remotes.some((r) => r.name === name))
    throw new GitError(`Unknown remote: ${name}`, 'Pick a configured remote', 400);
  await gitRun(repoPath, ['ls-remote', '--exit-code', name], NET_ENV);
}
