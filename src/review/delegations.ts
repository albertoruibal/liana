// Forge delegations. These keep the historical exported names used by the API
// router. They resolve the forge per repository (settings preference -> origin
// host -> configured token), defaulting to GitLab so existing installations are
// unchanged. Node-only.

import { forgeByKind, resolveForge } from '../forges';
import { gitlabForge } from '../gitlab';
import type { DiffRefs, ReviewChanges, ReviewComment, ReviewRequest } from '../types';

/** List open merge/pull requests for the repository's resolved forge. */
export async function listMergeRequests(repoPath: string): Promise<ReviewRequest[]> {
  const forge = await resolveForge(repoPath);
  return forge.listRequests(repoPath);
}

/** Fetch one request with its changed files and diff refs. */
export async function getMergeRequestChanges(
  repoPath: string,
  iid: number,
): Promise<ReviewChanges> {
  const forge = await resolveForge(repoPath);
  return forge.getChanges(repoPath, iid);
}

/** Make the request head commit available to the read-only tools. */
export async function ensureMergeRequestRefs(
  repoPath: string,
  changes: ReviewChanges,
): Promise<{ fetched: boolean }> {
  return forgeByKind(changes.forge).ensureRefs(repoPath, changes);
}

/** Post one approved comment on the repository's forge. */
export async function createDiscussion(
  repoPath: string,
  iid: number,
  comment: ReviewComment,
  refs: DiffRefs,
  forgeKind?: ReviewChanges['forge'],
): Promise<string> {
  const forge = forgeKind ? forgeByKind(forgeKind) : await resolveForge(repoPath);
  return forge.postComment(repoPath, iid, comment, refs);
}

/** Approve a request on the repository's forge. */
export async function approveMergeRequest(
  repoPath: string,
  iid: number,
  forgeKind?: ReviewChanges['forge'],
): Promise<void> {
  const forge = forgeKind ? forgeByKind(forgeKind) : await resolveForge(repoPath);
  return forge.approve(repoPath, iid);
}

/** Cheap authenticated call used by the settings "Test" button (GitLab). */
export async function testGitLab(): Promise<string> {
  return gitlabForge.test();
}

/** Cheap authenticated call against an explicit forge (settings "Test"). */
export async function testForge(kind: ReviewChanges['forge']): Promise<string> {
  return forgeByKind(kind).test();
}
