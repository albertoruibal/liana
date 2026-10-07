// Browser-side mirror of src/api/operations.ts: rebase / merge / cherry-pick / revert.

import { git } from './exec';

/** Rebase the current branch onto `onto`. Uncommitted changes are not allowed by git. */
export async function rebaseOnto(repoPath: string, onto: string): Promise<string> {
  const out = await git(repoPath, ['rebase', onto]);
  return out.trim();
}

/** Merge `ref` into the checked-out branch; `--no-edit` keeps git from opening an editor. */
export async function mergeBranch(repoPath: string, ref: string): Promise<string> {
  const out = await git(repoPath, ['merge', '--no-edit', ref]);
  return out.trim();
}

/**
 * Cherry-pick `ref` onto the current branch.
 * `mainline` selects the parent of a merge commit (git -m N);
 * `record` appends "(cherry picked from ...)" to the message (git -x).
 */
export async function cherryPick(
  repoPath: string,
  ref: string,
  opts: { mainline?: number; record?: boolean } = {},
): Promise<string> {
  const args = ['cherry-pick'];
  if (opts.record) args.push('-x');
  if (opts.mainline !== undefined) args.push('-m', String(opts.mainline));
  args.push(ref);
  const out = await git(repoPath, args);
  return out.trim();
}

/**
 * Revert `ref` on the current branch, creating the inverse commit.
 * `--no-edit` keeps git from opening an editor; `mainline` selects the parent
 * of a merge commit (git -m N). A conflict leaves REVERT_HEAD for the banner.
 */
export async function revertCommit(
  repoPath: string,
  ref: string,
  opts: { mainline?: number } = {},
): Promise<string> {
  const args = ['revert', '--no-edit'];
  if (opts.mainline !== undefined) args.push('-m', String(opts.mainline));
  args.push(ref);
  const out = await git(repoPath, args);
  return out.trim();
}
