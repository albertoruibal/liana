// Browser-side mirror of src/api/stash.ts: stash.

import { git, GitError } from './exec';
import { loadStashes } from './repo';
import type { StashInfo } from '../types';

/** Resolve a stash WIP commit hash to its current reflog selector. */
export async function resolveStash(repoPath: string, hash: string): Promise<string> {
  const { stashes } = await loadStashes(repoPath);
  const info = stashes.get(hash);
  if (!info) throw new GitError(`Unknown stash ${hash}`, 'No such stash');
  return info.selector;
}

/** `git stash push`; `includeUntracked` maps to `-u`. Returns the WIP hash, or '' when clean. */
export async function createStash(
  repoPath: string,
  message: string,
  includeUntracked: boolean,
): Promise<string> {
  const m = message.trim();
  const args = ['stash', 'push'];
  if (m) args.push('-m', m);
  if (includeUntracked) args.push('-u');
  const out = await git(repoPath, args);
  if (/No local changes to save/i.test(out)) return '';
  const { stashes } = await loadStashes(repoPath);
  const first = stashes.values().next().value as StashInfo | undefined;
  return first?.hash ?? '';
}

/** `git stash apply` a selector; keeps the stash in place. */
export async function applyStash(repoPath: string, selector: string): Promise<string> {
  return (await git(repoPath, ['stash', 'apply', selector])).trim();
}

/** `git stash drop` a selector; removes one stash entry. */
export async function dropStash(repoPath: string, selector: string): Promise<string> {
  return (await git(repoPath, ['stash', 'drop', selector])).trim();
}
