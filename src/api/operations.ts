// Commit-graph operations: rebase / merge / cherry-pick / revert. Node-only.
// Mirrored by src/git/operations.ts.

import { gitRun } from './exec';

export async function rebaseOnto(repoPath: string, onto: string): Promise<string> {
  const out = await gitRun(repoPath, ['rebase', onto]);
  return out.trim();
}

/** Merge `ref` into the checked-out branch; `--no-edit` keeps git from opening an editor. */
export async function mergeBranch(repoPath: string, ref: string): Promise<string> {
  const out = await gitRun(repoPath, ['merge', '--no-edit', ref]);
  return out.trim();
}

export async function cherryPick(
  repoPath: string,
  ref: string,
  opts: { mainline?: number; record?: boolean } = {},
): Promise<string> {
  const args = ['cherry-pick'];
  if (opts.record) args.push('-x');
  if (opts.mainline !== undefined) args.push('-m', String(opts.mainline));
  args.push(ref);
  const out = await gitRun(repoPath, args);
  return out.trim();
}

/**
 * Revert `ref` on the current branch, creating the inverse commit.
 * `--no-edit` keeps git from opening an editor; `mainline` selects the parent
 * of a merge commit (git -m N). A conflict leaves REVERT_HEAD for the banner.
 */
export async function revert(
  repoPath: string,
  ref: string,
  opts: { mainline?: number } = {},
): Promise<string> {
  const args = ['revert', '--no-edit'];
  if (opts.mainline !== undefined) args.push('-m', String(opts.mainline));
  args.push(ref);
  const out = await gitRun(repoPath, args);
  return out.trim();
}
