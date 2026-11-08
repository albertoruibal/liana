// Build a review target for a single local commit. Node-only: imported by the
// API router and its src/git mirror, never by the browser bundle.
//
// The commit is diffed against its first parent (matching `git show
// --first-parent`); a root commit has no base. Review comments stay local —
// there is no forge request to post them to.

import { commitFiles, commitPatch } from '../api/diffs';
import { resolveForge } from '../forges';
import { runGit } from '../forge';
import type {
  ReviewChanges,
  ReviewCommitInfo,
  ReviewFile,
  ReviewJob,
  ReviewRuleConfig,
} from '../types';
import { startReview } from './jobs';

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

/** Whether `value` is a full 40-char commit hash (short hashes are not accepted). */
export function isFullCommitHash(value: string): boolean {
  return FULL_SHA_RE.test(value.trim());
}

/** Resolve a local commit and build the synthetic ReviewChanges for it. */
export async function reviewChangesForCommit(
  repoPath: string,
  hash: string,
): Promise<ReviewChanges> {
  const requested = hash.trim();
  if (!isFullCommitHash(requested)) throw new Error('Invalid commit hash');

  // Canonicalize and verify in one step; this also rejects objects that are not
  // commits while never treating the hash as a command-line option.
  const sha = (
    await runGit(repoPath, ['rev-parse', '--verify', `${requested}^{commit}`])
  ).trim();
  if (!sha) throw new Error(`Commit ${requested.slice(0, 10)} is not available locally`);

  const [metaOut, baseOut, files, forge] = await Promise.all([
    runGit(repoPath, ['show', '-s', '--format=%s%x00%an%x00%at', sha]),
    runGit(repoPath, ['rev-parse', '--verify', `${sha}^`]).catch(() => ''),
    commitFiles(repoPath, sha),
    resolveForge(repoPath),
  ]);

  const [subject = '', author = '', at = '0'] = metaOut.split('\0');
  const timestamp = Number(at.trim()) || 0;
  const baseHash = baseOut.trim() || null;
  const shortHash = sha.slice(0, 8);

  const reviewFiles: ReviewFile[] = [];
  for (const file of files) {
    const oldPath = file.oldPath ?? file.path;
    // Binary and gitlink diffs carry no reviewable lines; the model reads the
    // commit tree through the repository tools instead.
    const diff =
      file.binary || file.isSubmodule
        ? ''
        : await commitPatch(repoPath, sha, file.path, file.oldPath).catch(() => '');
    reviewFiles.push({
      oldPath,
      newPath: file.path,
      newFile: file.status === 'A',
      deletedFile: file.status === 'D',
      renamedFile: file.status === 'R' || file.status === 'C',
      diff,
    });
  }

  const commit: ReviewCommitInfo = {
    hash: sha,
    shortHash,
    subject,
    author,
    timestamp,
    baseHash,
  };

  return {
    forge: forge.kind,
    mr: {
      iid: 0,
      title: subject,
      author,
      sourceBranch: shortHash,
      targetBranch: baseHash ? baseHash.slice(0, 8) : '',
      state: 'commit',
      webUrl: '',
      updatedAt: timestamp > 0 ? new Date(timestamp * 1000).toISOString() : '',
      draft: false,
    },
    files: reviewFiles,
    diffRefs: {
      baseSha: baseHash ?? '',
      headSha: sha,
      startSha: baseHash ?? '',
    },
    commit,
  };
}

export interface StartCommitReviewOptions {
  repoPath: string;
  hash: string;
  providerId?: string;
  rule?: Partial<ReviewRuleConfig>;
}

/** Build the commit's review target and start a background review job. */
export async function startCommitReview(
  opts: StartCommitReviewOptions,
): Promise<{ job: ReviewJob; changes: ReviewChanges }> {
  const changes = await reviewChangesForCommit(opts.repoPath, opts.hash);
  const job = startReview({
    repoPath: opts.repoPath,
    changes,
    providerId: opts.providerId,
    rule: opts.rule,
  });
  return { job, changes };
}
