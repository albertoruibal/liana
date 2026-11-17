// Diffs and blob reads for the commit detail pane and Monaco viewers. Node-only.
// Mirrored by src/git/diffs.ts.

import { gitRun, GitError } from './exec';
import { looksBinary, readRepoFile } from './paths';
import { headExists, loadStatus } from './repo';
import { validRefName } from './branches';
import { parseCommitFiles } from '../commit-files';
import type { CommitFile, FileContents } from '../types';

/** Resolved endpoints of a local branch/tag/commit comparison. */
export interface CompareTarget {
  /** Base/destination tip. */
  baseSha: string;
  /** Head/source tip. */
  headSha: string;
  /** Tree diff base: the merge base, or `baseSha` in direct mode. */
  diffBaseSha: string;
  /** Common ancestor, or null in direct mode. */
  mergeBaseSha: string | null;
  /** Commits reachable from head but not base. */
  ahead: number;
  /** Commits reachable from base but not head. */
  behind: number;
}

/**
 * Files changed by a commit, with per-file line counts. Uses `--first-parent` so a
 * merge commit reports the changes it introduces relative to its mainline parent,
 * matching `git show`.
 */
export async function commitFiles(repoPath: string, hash: string): Promise<CommitFile[]> {
  const [nameStatusOut, numstatOut, rawOut] = await Promise.all([
    gitRun(repoPath, ['show', '--name-status', '-z', '--format=', '--find-renames', '--first-parent', hash]),
    gitRun(repoPath, ['show', '--numstat', '-z', '--format=', '--find-renames', '--first-parent', hash]),
    gitRun(repoPath, ['show', '--raw', '-z', '--format=', '--find-renames', '--first-parent', hash]),
  ]);
  return parseCommitFiles(nameStatusOut, numstatOut, rawOut);
}

/** Unified diff for one file of a commit; `oldPath` included so renames diff as renames. */
export async function commitPatch(
  repoPath: string,
  hash: string,
  filePath: string,
  oldPath: string | null,
): Promise<string> {
  const paths = oldPath && oldPath !== filePath ? [oldPath, filePath] : [filePath];
  return (
    await gitRun(repoPath, [
      'show',
      '--format=',
      '--no-color',
      '--find-renames',
      '--first-parent',
      hash,
      '--',
      ...paths,
    ])
  ).trim();
}

/** Validate a user-supplied ref before it reaches git. */
function validCompareRef(ref: string): string {
  const name = ref.trim();
  if (!validRefName(name)) {
    throw new GitError(`Invalid ref: ${ref}`, `"${name}" is not a valid branch, tag, or commit`, 400);
  }
  return name;
}

/** Resolve a branch/tag/commit to a commit SHA, with an actionable failure. */
async function resolveCommitRef(repoPath: string, ref: string): Promise<string> {
  const name = validCompareRef(ref);
  try {
    const sha = (
      await gitRun(repoPath, ['rev-parse', '--verify', '--end-of-options', `${name}^{commit}`])
    ).trim();
    if (sha) return sha;
  } catch (err) {
    const detail = err instanceof GitError ? err.stderr || err.message : String(err);
    throw new GitError(
      `Cannot resolve "${name}" locally`,
      detail
        ? `Cannot resolve "${name}" locally: ${detail}`
        : `Cannot resolve "${name}" locally — fetch or pull it first.`,
      400,
    );
  }
  throw new GitError(`Cannot resolve "${name}" locally`, `Ref "${name}" has no commit`, 400);
}

/**
 * Resolve both sides of a comparison. Merge-base mode diffs from the common
 * ancestor to the head (what a merge/pull request shows); direct mode diffs the
 * two tips. Local only: refs that are not present are reported, never fetched.
 */
export async function resolveCompareTarget(
  repoPath: string,
  baseRef: string,
  headRef: string,
  mergeBase: boolean,
): Promise<CompareTarget> {
  const [baseSha, headSha] = await Promise.all([
    resolveCommitRef(repoPath, baseRef),
    resolveCommitRef(repoPath, headRef),
  ]);
  let mergeBaseSha: string | null = null;
  let diffBaseSha = baseSha;
  if (mergeBase) {
    try {
      mergeBaseSha =
        (await gitRun(repoPath, ['merge-base', baseSha, headSha])).trim() || null;
    } catch {
      mergeBaseSha = null;
    }
    if (!mergeBaseSha) {
      throw new GitError(
        `No common ancestor between ${baseRef.trim()} and ${headRef.trim()}`,
        'The branches have no common ancestor; compare their tips instead.',
        400,
      );
    }
    diffBaseSha = mergeBaseSha;
  }
  let ahead = 0;
  let behind = 0;
  try {
    const out = (
      await gitRun(repoPath, ['rev-list', '--left-right', '--count', `${baseSha}...${headSha}`])
    ).trim();
    const [behindStr = '0', aheadStr = '0'] = out.split(/\s+/);
    behind = Number(behindStr) || 0;
    ahead = Number(aheadStr) || 0;
  } catch {
    // Counts are informational; the diff itself still works.
  }
  return { baseSha, headSha, diffBaseSha, mergeBaseSha, ahead, behind };
}

/** Files changed between the comparison's diff base and its head. */
export async function compareFiles(repoPath: string, target: CompareTarget): Promise<CommitFile[]> {
  const [nameStatusOut, numstatOut, rawOut] = await Promise.all([
    gitRun(repoPath, [
      'diff',
      '--name-status',
      '-z',
      '--find-renames',
      target.diffBaseSha,
      target.headSha,
    ]),
    gitRun(repoPath, ['diff', '--numstat', '-z', '--find-renames', target.diffBaseSha, target.headSha]),
    gitRun(repoPath, ['diff', '--raw', '-z', '--find-renames', target.diffBaseSha, target.headSha]),
  ]);
  return parseCommitFiles(nameStatusOut, numstatOut, rawOut);
}

/** Unified diff for one file of a comparison; renames keep their source path. */
export async function comparePatch(
  repoPath: string,
  target: CompareTarget,
  filePath: string,
  oldPath: string | null,
): Promise<string> {
  const paths = oldPath && oldPath !== filePath ? [oldPath, filePath] : [filePath];
  return (
    await gitRun(repoPath, [
      'diff',
      '--no-color',
      '--find-renames',
      target.diffBaseSha,
      target.headSha,
      '--',
      ...paths,
    ])
  ).trim();
}

// Git's well-known empty tree object id; diffing against it works on an unborn HEAD.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * Unified diff of a working-tree path against HEAD (staged + unstaged combined).
 * `oldPath` is included so a rename diffs as a rename. On an unborn branch the
 * empty tree stands in for HEAD, and untracked files (which `git diff HEAD`
 * skips) fall back to a `/dev/null` comparison.
 */
export async function worktreePatch(
  repoPath: string,
  filePath: string,
  oldPath: string | null,
): Promise<string> {
  const paths = oldPath && oldPath !== filePath ? [oldPath, filePath] : [filePath];
  const base = (await headExists(repoPath)) ? 'HEAD' : EMPTY_TREE;
  try {
    const out = await gitRun(repoPath, [
      'diff',
      '--no-color',
      '--find-renames',
      base,
      '--',
      ...paths,
    ]);
    if (out.trim()) return out.trim();
  } catch {
    // Fall through to the untracked-file check below.
  }
  // An empty diff means either a clean tracked path (no output) or an untracked
  // path (`git diff HEAD` ignores untracked files). Only the latter gets the
  // /dev/null comparison, so a clean file doesn't render as brand new.
  try {
    await gitRun(repoPath, ['ls-files', '--error-unmatch', '--', filePath]);
    return '';
  } catch {
    // Path is untracked — compare it against /dev/null below.
  }
  try {
    return (
      await gitRun(repoPath, ['diff', '--no-color', '--no-index', '--', '/dev/null', filePath])
    ).trim();
  } catch (err) {
    // `--no-index` exits 1 whenever the files differ, and gitRun surfaces that
    // stdout through GitError.stderr. A real failure (missing path) has none.
    if (err instanceof GitError && err.stderr.trim().startsWith('diff --git')) {
      return err.stderr.trim();
    }
    return '';
  }
}

/**
 * Gather the working-tree diffs for an explicit set of paths, for AI commit
 * message generation. Paths are intersected with the live status so a caller
 * can't read outside the working tree; renames use the recorded source path.
 * Binary/empty diffs are skipped and the combined text is truncated.
 */
export async function selectedWorktreeDiffs(
  repoPath: string,
  files: string[],
  maxChars: number,
): Promise<string> {
  const status = await loadStatus(repoPath);
  const selected = new Set(files);
  const parts: string[] = [];
  let total = 0;
  for (const entry of status.entries) {
    if (!selected.has(entry.path)) continue;
    const patch = await worktreePatch(repoPath, entry.path, entry.oldPath).catch(() => '');
    if (!patch.trim() || patch.includes('Binary files')) continue;
    const remaining = maxChars - total;
    if (remaining <= 0) break;
    const slice = patch.length > remaining ? `${patch.slice(0, remaining)}\n… [truncated]` : patch;
    parts.push(slice);
    total += slice.length;
  }
  return parts.join('\n\n');
}


/** Resolve a commit-ish for a content read, or null when empty/unavailable. */
async function resolveContentRef(repoPath: string, ref: string): Promise<string | null> {
  const name = ref.trim();
  if (!name || !validRefName(name)) return null;
  try {
    return (
      (await gitRun(repoPath, ['rev-parse', '--verify', '--end-of-options', `${name}^{commit}`])).trim() ||
      null
    );
  } catch {
    return null;
  }
}

/**
 * Original / modified text of one file between two commit-ish refs, for the
 * full-file review diff. Missing sides are null (new/deleted files); binary
 * sides omit their text.
 */
export async function fileContentsBetween(
  repoPath: string,
  baseRef: string,
  headRef: string,
  filePath: string,
  oldPath: string | null,
): Promise<FileContents> {
  const head = await resolveContentRef(repoPath, headRef);
  if (!head) throw new GitError('The reviewed head commit is not available locally', '', 400);
  const wantsBase = !!baseRef.trim();
  const base = await resolveContentRef(repoPath, baseRef);
  if (wantsBase && !base) {
    throw new GitError('The reviewed base commit is not available locally', '', 400);
  }
  const src = oldPath && oldPath !== filePath ? oldPath : filePath;
  const readBlob = async (sha: string, path: string): Promise<string | null> => {
    try {
      return await gitRun(repoPath, ['show', `${sha}:${path}`]);
    } catch {
      return null;
    }
  };
  const original = base ? await readBlob(base, src) : null;
  const modified = await readBlob(head, filePath);
  const binary = [original, modified].some((t) => t !== null && looksBinary(t));
  return {
    path: filePath,
    original: binary ? null : original,
    modified: binary ? null : modified,
    binary,
  };
}

/**
 * Original / modified text of one file for the Monaco diff and code viewer.
 * Commit mode (`hash` set): the parent tree (`<hash>^`, first-parent-consistent)
 * vs. the commit tree. Worktree mode (`hash` null): HEAD vs. the on-disk file.
 * Missing sides are null; binary sides omit their text.
 */
export async function fileContents(
  repoPath: string,
  hash: string | null,
  filePath: string,
  oldPath: string | null,
): Promise<FileContents> {
  const src = oldPath && oldPath !== filePath ? oldPath : filePath;
  const readBlob = async (spec: string): Promise<string | null> => {
    try {
      return await gitRun(repoPath, ['show', spec]);
    } catch {
      return null;
    }
  };
  let original: string | null;
  let modified: string | null;
  if (hash) {
    original = await readBlob(`${hash}^:${src}`);
    modified = await readBlob(`${hash}:${filePath}`);
  } else {
    original = (await headExists(repoPath)) ? await readBlob(`HEAD:${src}`) : null;
    modified = readRepoFile(repoPath, filePath);
  }
  const binary = [original, modified].some((t) => t !== null && looksBinary(t));
  return {
    path: filePath,
    original: binary ? null : original,
    modified: binary ? null : modified,
    binary,
  };
}
