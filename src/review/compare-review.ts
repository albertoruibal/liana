// Build a review target for a local comparison between two git refs. Node-only:
// imported by the API router and its src/git mirror, never by the browser bundle.
//
// The comparison is purely local: refs must already exist (branches, remote-
// tracking refs, tags, or commit SHAs). Nothing is fetched, and the resulting
// comments stay local — there is no forge request to post them to.

import { compareFiles, comparePatch, resolveCompareTarget } from '../api/diffs';
import { resolveForge } from '../forges';
import type {
  CompareRefsRequest,
  ReviewChanges,
  ReviewCompareInfo,
  ReviewFile,
  ReviewJob,
  ReviewRuleConfig,
} from '../types';
import { startReview } from './jobs';

/** Build the synthetic ReviewChanges for a local branch comparison. */
export async function reviewChangesForCompare(
  repoPath: string,
  refs: CompareRefsRequest,
): Promise<ReviewChanges> {
  const baseRef = refs.base.trim();
  const headRef = refs.head.trim();
  const target = await resolveCompareTarget(repoPath, baseRef, headRef, refs.mergeBase);
  const [files, forge] = await Promise.all([
    compareFiles(repoPath, target),
    resolveForge(repoPath),
  ]);

  const reviewFiles: ReviewFile[] = [];
  for (const file of files) {
    const oldPath = file.oldPath ?? file.path;
    // Binary and gitlink diffs carry no reviewable lines; the model reads the
    // comparison head through the repository tools instead.
    const diff =
      file.binary || file.isSubmodule
        ? ''
        : await comparePatch(repoPath, target, file.path, file.oldPath).catch(() => '');
    reviewFiles.push({
      oldPath,
      newPath: file.path,
      newFile: file.status === 'A',
      deletedFile: file.status === 'D',
      renamedFile: file.status === 'R' || file.status === 'C',
      diff,
      binary: file.binary,
      isSubmodule: file.isSubmodule,
    });
  }

  const compare: ReviewCompareInfo = {
    baseRef,
    headRef,
    baseSha: target.baseSha,
    headSha: target.headSha,
    mergeBaseSha: target.mergeBaseSha,
    mode: refs.mergeBase ? 'merge-base' : 'direct',
    ahead: target.ahead,
    behind: target.behind,
  };

  return {
    forge: forge.kind,
    mr: {
      iid: 0,
      title: `${headRef} → ${baseRef}`,
      author: '',
      sourceBranch: headRef,
      targetBranch: baseRef,
      state: 'compare',
      webUrl: '',
      updatedAt: '',
      draft: false,
    },
    files: reviewFiles,
    // GitLab-like refs: base/start point at the merge base, head at the source.
    diffRefs: {
      baseSha: target.mergeBaseSha ?? target.baseSha,
      headSha: target.headSha,
      startSha: target.baseSha,
    },
    compare,
  };
}

export interface StartCompareReviewOptions extends CompareRefsRequest {
  repoPath: string;
  providerId?: string;
  rule?: Partial<ReviewRuleConfig>;
}

/** Build the comparison's review target and start a background review job. */
export async function startCompareReview(
  opts: StartCompareReviewOptions,
): Promise<{ job: ReviewJob; changes: ReviewChanges }> {
  const changes = await reviewChangesForCompare(opts.repoPath, opts);
  const job = startReview({
    repoPath: opts.repoPath,
    changes,
    providerId: opts.providerId,
    rule: opts.rule,
  });
  return { job, changes };
}
