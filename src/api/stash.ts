// Stash. Node-only. Mirrored by src/git/stash.ts.

import { gitRun, GitError } from './exec';
import { loadStashes } from './repo';
import type { StashInfo } from '../types';

/** Resolve a stash WIP commit hash to its current reflog selector. */
export async function resolveStash(repoPath: string, hash: string): Promise<string> {
  const { stashes } = await loadStashes(repoPath);
  const info = stashes.get(hash);
  if (!info) throw new GitError(`Unknown stash ${hash}`, 'No such stash');
  return info.selector;
}

/** `git stash push`; `includeUntracked` maps to `-u`. */
export async function createStash(
  repoPath: string,
  message: string,
  includeUntracked: boolean,
): Promise<string> {
  const m = message.trim();
  const args = ['stash', 'push'];
  if (m) args.push('-m', m);
  if (includeUntracked) args.push('-u');
  const out = await gitRun(repoPath, args);
  // With no local changes git exits 0 and prints "No local changes to save".
  if (/No local changes to save/i.test(out)) return '';
  const { stashes } = await loadStashes(repoPath);
  // The newest stash is stash@{0}; report its WIP hash.
  const first = stashes.values().next().value as StashInfo | undefined;
  return first?.hash ?? '';
}

/** `git stash apply` a selector; keeps the stash in place. */
export async function applyStash(repoPath: string, selector: string): Promise<string> {
  return (await gitRun(repoPath, ['stash', 'apply', selector])).trim();
}

/** `git stash drop` a selector; removes one stash entry. */
export async function dropStash(repoPath: string, selector: string): Promise<string> {
  return (await gitRun(repoPath, ['stash', 'drop', selector])).trim();
}
