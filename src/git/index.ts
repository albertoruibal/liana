// Browser-side git contract: a typed mirror of the Node backend (src/api/).
// Kept in sync with src/api/ module-for-module on purpose (see AGENTS.md).
// The browser UI talks to /api; these wrappers document and type the contract.

import { git } from './exec';
import { loadStatus } from './repo';
import { worktreePatch } from './diffs';

export { GitError, UNIT, NET_ENV, git, repoActivity } from './exec';
export { isGitRepo, loadLog, loadStashes, loadRepoRefs, loadRepoState, loadStatus, headExists, dirtyCount, dirtyGuard, createCommit } from './repo';
export { rebaseOnto, mergeBranch, cherryPick, revertCommit } from './operations';
export {
  loadMergeState,
  loadConflicts,
  loadConflictFile,
  writeWorkingFile,
  resolveConflict,
  continueOperation,
  abortOperation,
  skipOperation,
} from './conflicts';
export {
  loadSubmodules,
  submoduleUpdate,
  submoduleSync,
  submoduleAdd,
  submoduleDeinit,
  loadSubmoduleLog,
} from './submodules';
export {
  loadWorktrees,
  worktreeAdd,
  worktreeRemove,
  worktreeLock,
  worktreeUnlock,
  worktreeMove,
  worktreePrune,
} from './worktrees';
export { commitFiles, commitPatch, worktreePatch, selectedWorktreeDiffs, fileContents } from './diffs';
export { loadRebasePlan, executeRebase, type RebasePlanItem } from './rebase';
export { validRefName, remoteBranchLocalName, checkoutBranch, createBranch, deleteBranch, deleteRemoteBranchPush, createTag, deleteTag } from './branches';
export { currentBranch, loadRemotes, upstreamRef, loadRemoteStatus, pushBranch, pullBranch, testRemote } from './remotes';
export { resetBranch } from './reset';
export { resolveStash, createStash, applyStash, dropStash } from './stash';
export { apiListRequests, apiGetRequestChanges, apiApproveRequest, apiTestForge } from './forge';

/**
 * Generate a commit message for the given working-tree paths (mirrors
 * `POST /api/commit-message` in src/api/index.ts). Read-only: reads the same
 * diffs the commit dialog shows and the recent subjects, then asks the active
 * provider. The browser UI calls this over `/api`; this wrapper keeps the typed
 * contract in sync.
 */
export async function apiGenerateCommitMessage(
  repoPath: string,
  files: string[],
  providerId?: string,
): Promise<string> {
  const [{ commitRule }, { generateCommitMessage }] = await Promise.all([
    import('../settings'),
    import('../review'),
  ]);
  const rule = commitRule();
  const status = await loadStatus(repoPath);
  const selected = new Set(files);
  const parts: string[] = [];
  let total = 0;
  for (const entry of status.entries) {
    if (!selected.has(entry.path)) continue;
    const patch = await worktreePatch(repoPath, entry.path, entry.oldPath).catch(() => '');
    if (!patch.trim() || patch.includes('Binary files')) continue;
    const remaining = rule.maxDiffChars - total;
    if (remaining <= 0) break;
    const slice = patch.length > remaining ? `${patch.slice(0, remaining)}\n… [truncated]` : patch;
    parts.push(slice);
    total += slice.length;
  }
  let history: string[] = [];
  if (rule.includeHistory) {
    try {
      history = (await git(repoPath, ['log', '-n', '20', '--format=%s']))
        .split('\n')
        .filter((s) => s.trim().length > 0);
    } catch {
      // Unborn HEAD has no history.
    }
  }
  return generateCommitMessage(rule, { diff: parts.join('\n\n'), history }, providerId);
}
