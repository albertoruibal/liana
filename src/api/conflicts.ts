// Merge / rebase / cherry-pick / revert conflict state, read from git metadata.
// Node-only. Mirrored by src/git/conflicts.ts.

import fs from 'node:fs';
import path from 'node:path';
import { gitRun, GitError } from './exec';
import { looksBinary, readRepoFile, safeResolve } from './paths';
import { parseUnmerged } from '../commit-files';
import type { ConflictEntry, ConflictFile, MergeOperation } from '../types';

/** Resolve a possibly-relative `--git-path` result against the repo's work tree. */
function repoAbs(repoPath: string, gitPath: string): string {
  return path.isAbsolute(gitPath) ? gitPath : path.join(repoPath, gitPath);
}

/** True when the given git metadata path currently exists on disk. */
async function gitPathExists(repoPath: string, name: string): Promise<boolean> {
  try {
    const out = (await gitRun(repoPath, ['rev-parse', '--git-path', name])).trim();
    return fs.existsSync(repoAbs(repoPath, out));
  } catch {
    return false;
  }
}

/** Read a file inside the git dir (e.g. `rebase-merge/onto`), or null when absent. */
async function readGitPath(repoPath: string, name: string): Promise<string | null> {
  try {
    const out = (await gitRun(repoPath, ['rev-parse', '--git-path', name])).trim();
    const abs = repoAbs(repoPath, out);
    return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8').trim() : null;
  } catch {
    return null;
  }
}

/** Strip refs/heads/ or refs/remotes/ from a full ref name, leaving a short branch name. */
function shortRefName(full: string): string {
  return full.replace(/^refs\/(?:heads|remotes)\//, '');
}

/** Short name of the branch the rebase is replaying, from `head-name`. */
async function rebaseHeadName(repoPath: string): Promise<string | null> {
  const full =
    (await readGitPath(repoPath, 'rebase-merge/head-name')) ??
    (await readGitPath(repoPath, 'rebase-apply/head-name'));
  return full ? shortRefName(full) : null;
}

/**
 * Best short name for a commit: a local branch pointing at it (the common case for
 * a rebase base), otherwise the symbolic ref (`git name-rev`), or null. Remote-tracking
 * names are dropped so a stale `origin/x` can't masquerade as a local branch.
 */
async function refNameAt(repoPath: string, sha: string): Promise<string | null> {
  try {
    const out = (await gitRun(repoPath, ['for-each-ref', '--format=%(refname)', '--points-at', sha])).trim();
    const locals = out
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.startsWith('refs/heads/'));
    if (locals[0]) return shortRefName(locals[0]);
  } catch {
    // Fall through to name-rev.
  }
  try {
    const name = (await gitRun(repoPath, ['name-rev', '--name-only', '--refs=refs/heads/*', sha])).trim();
    if (name && name !== 'undefined' && !name.endsWith('^0')) return name;
  } catch {
    // No name available.
  }
  return null;
}

/** Branch names for the ours / theirs sides of the in-progress operation, when known. */
async function conflictSideLabels(
  repoPath: string,
  kind: MergeOperation['kind'],
  onto: string | null,
): Promise<{ oursLabel: string | null; theirsLabel: string | null }> {
  if (kind === 'none') return { oursLabel: null, theirsLabel: null };
  if (kind === 'rebase') {
    return { oursLabel: await rebaseHeadName(repoPath), theirsLabel: onto ? await refNameAt(repoPath, onto) : null };
  }
  if (kind === 'merge') {
    const theirs = onto ?? (await readGitPath(repoPath, 'MERGE_HEAD'));
    return { oursLabel: null, theirsLabel: theirs ? await refNameAt(repoPath, theirs) : null };
  }
  return { oursLabel: null, theirsLabel: null };
}

/**
 * Merge / rebase / cherry-pick / revert state, read from git's own metadata files
 * (never inferred). `onto` is the commit the operation applies onto when known.
 * `conflicts` may be passed in to avoid a second `git ls-files -u`.
 */
export async function loadMergeState(
  repoPath: string,
  conflicts?: ConflictEntry[],
): Promise<MergeOperation> {
  const [rebaseMerge, rebaseApply, mergeHead, cherryHead, revertHead] = await Promise.all([
    gitPathExists(repoPath, 'rebase-merge'),
    gitPathExists(repoPath, 'rebase-apply'),
    gitPathExists(repoPath, 'MERGE_HEAD'),
    gitPathExists(repoPath, 'CHERRY_PICK_HEAD'),
    gitPathExists(repoPath, 'REVERT_HEAD'),
  ]);
  const unmerged = conflicts ?? (await loadConflicts(repoPath));
  let kind: MergeOperation['kind'] = 'none';
  let onto: string | null = null;
  if (rebaseMerge || rebaseApply) {
    kind = 'rebase';
    onto = await readGitPath(repoPath, 'rebase-merge/onto');
  } else if (mergeHead) {
    kind = 'merge';
    onto = await readGitPath(repoPath, 'MERGE_HEAD');
  } else if (cherryHead) {
    kind = 'cherry-pick';
    onto = await readGitPath(repoPath, 'CHERRY_PICK_HEAD');
  } else if (revertHead) {
    kind = 'revert';
    onto = await readGitPath(repoPath, 'REVERT_HEAD');
  }
  const labels = await conflictSideLabels(repoPath, kind, onto);
  return { kind, inProgress: kind !== 'none', onto, conflictCount: unmerged.length, ...labels };
}

/** Unmerged index entries (`git ls-files -u`), parsed into conflict records. */
export async function loadConflicts(repoPath: string): Promise<ConflictEntry[]> {
  const out = await gitRun(repoPath, ['ls-files', '-u', '-z']);
  return parseUnmerged(out);
}

/** A blob or gitlink id as text, or null when the path has no such index stage. */
async function readStage(repoPath: string, stage: number, filePath: string): Promise<string | null> {
  try {
    const out = await gitRun(repoPath, ['show', `:${stage}:${filePath}`]);
    return out;
  } catch {
    return null;
  }
}

/**
 * Base / ours / theirs contents for one conflicted path, for the resolve dialog.
 * `conflicts`/`operation` may be passed in to avoid redundant git calls.
 */
export async function loadConflictFile(
  repoPath: string,
  filePath: string,
  conflicts?: ConflictEntry[],
  operation?: MergeOperation,
): Promise<ConflictFile> {
  const entries = conflicts ?? (await loadConflicts(repoPath));
  const entry = entries.find((c) => c.path === filePath);
  if (!entry) throw new GitError(`Not a conflicted path: ${filePath}`, 'Path is not unmerged', 400);
  const [base, ours, theirs] = await Promise.all([
    readStage(repoPath, 1, filePath),
    readStage(repoPath, 2, filePath),
    readStage(repoPath, 3, filePath),
  ]);
  const isBinary = [base, ours, theirs].some((t) => t !== null && looksBinary(t));
  const worktree = readRepoFile(repoPath, filePath);
  const op = operation ?? (await loadMergeState(repoPath, entries));
  return {
    path: filePath,
    type: entry.type,
    hasBase: entry.baseHash !== null,
    hasOurs: entry.oursHash !== null,
    hasTheirs: entry.theirsHash !== null,
    isBinary,
    isSubmodule: entry.isSubmodule,
    base: isBinary && !entry.isSubmodule ? null : base,
    ours: isBinary && !entry.isSubmodule ? null : ours,
    theirs: isBinary && !entry.isSubmodule ? null : theirs,
    worktree: isBinary && !entry.isSubmodule ? null : worktree,
    worktreeAvailable: worktree !== null,
    oursLabel: op.oursLabel,
    theirsLabel: op.theirsLabel,
  };
}

/**
 * Write the resolved working-tree file. Traversal-guarded to stay inside the repo;
 * used only to save a manually resolved conflict. No git operation state is touched.
 */
export async function writeWorkingFile(
  repoPath: string,
  filePath: string,
  content: string,
): Promise<void> {
  const abs = safeResolve(repoPath, filePath);
  if (!abs) throw new GitError(`Invalid path: ${filePath}`, 'Path escapes the repository', 400);
  fs.writeFileSync(abs, content, 'utf8');
}

/**
 * Resolve one conflicted path to a side (`ours`/`theirs`) or accept the working-tree
 * file as-is (`resolved`). Uses git's own checkout/rm/add; Liana writes no content.
 */
export async function resolveConflict(
  repoPath: string,
  filePath: string,
  resolution: 'ours' | 'theirs' | 'resolved',
): Promise<void> {
  if (resolution === 'resolved') {
    await gitRun(repoPath, ['add', '--', filePath]);
    return;
  }
  try {
    await gitRun(repoPath, ['checkout', `--${resolution}`, '--', filePath]);
    await gitRun(repoPath, ['add', '-A', '--', filePath]);
  } catch {
    // `git checkout --<side>` only fails when that side has no version of the path
    // (a delete/modify conflict), so choosing it means removing the file.
    await gitRun(repoPath, ['rm', '-f', '-q', '--', filePath]).catch(() => '');
  }
}

/** Continue the in-progress operation without opening an editor. */
export async function continueOperation(repoPath: string): Promise<string> {
  const { kind } = await loadMergeState(repoPath);
  if (kind === 'none') throw new GitError('No operation to continue', '', 400);
  if (kind === 'revert') {
    // `git revert --continue` opens an editor; commit explicitly instead.
    return (await gitRun(repoPath, ['commit', '--no-edit'])).trim();
  }
  return (await gitRun(repoPath, ['-c', 'core.editor=true', kind, '--continue'])).trim();
}

/** Abort the in-progress operation, restoring the pre-operation state. */
export async function abortOperation(repoPath: string): Promise<string> {
  const { kind } = await loadMergeState(repoPath);
  if (kind === 'none') throw new GitError('No operation to abort', '', 400);
  return (await gitRun(repoPath, [kind, '--abort'])).trim();
}

/** Skip the current patch of an in-progress rebase, cherry-pick, or revert. */
export async function skipOperation(repoPath: string): Promise<string> {
  const { kind } = await loadMergeState(repoPath);
  if (kind === 'none') throw new GitError('No operation to skip', '', 400);
  if (kind === 'merge') throw new GitError('Cannot skip a merge', 'Abort the merge instead', 400);
  return (await gitRun(repoPath, [kind, '--skip'])).trim();
}
