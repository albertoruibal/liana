// Pure parsing for `git show --name-status`/`--numstat` output.
// Shared by the browser mirror (src/git.ts) and the Node backend (src/api.ts) so
// the two copies of the git wrappers stay behaviorally identical. Node-free.

import type { CommitFile } from './types';

interface NameStatusEntry {
  status: string;
  path: string;
  oldPath: string | null;
}

interface NumstatEntry {
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

/** Parse `git show --name-status -z` into per-file statuses (NUL-delimited). */
function parseNameStatus(out: string): NameStatusEntry[] {
  const tokens = out.split('\0');
  const entries: NameStatusEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    const status = token[0] ?? '?';
    if (status === 'R' || status === 'C') {
      const oldPath = tokens[i + 1] ?? '';
      const path = tokens[i + 2] ?? '';
      i += 2;
      if (path) entries.push({ status, path, oldPath });
    } else {
      const path = tokens[i + 1] ?? '';
      i += 1;
      if (path) entries.push({ status, path, oldPath: null });
    }
  }
  return entries;
}

/** Parse `git show --numstat -z` line counts; binary files report `-`/`-`. */
function parseNumstat(out: string): NumstatEntry[] {
  const tokens = out.split('\0');
  const entries: NumstatEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    const first = token.indexOf('\t');
    const second = token.indexOf('\t', first + 1);
    if (first < 0 || second < 0) continue;
    const add = token.slice(0, first);
    const del = token.slice(first + 1, second);
    // Renames/copies leave the path empty and emit old + new paths as extra tokens.
    if (!token.slice(second + 1)) i += 2;
    const binary = add === '-' && del === '-';
    entries.push({
      additions: binary ? null : Number(add),
      deletions: binary ? null : Number(del),
      binary,
    });
  }
  return entries;
}

/**
 * Zip the `--name-status` and `--numstat` views of the same `git show` (same order)
 * into `CommitFile` records.
 */
export function parseCommitFiles(nameStatusOut: string, numstatOut: string): CommitFile[] {
  const names = parseNameStatus(nameStatusOut);
  const stats = parseNumstat(numstatOut);
  return names.map((n, i) => {
    const s = stats[i];
    return {
      path: n.path,
      oldPath: n.oldPath,
      status: n.status,
      additions: s?.additions ?? null,
      deletions: s?.deletions ?? null,
      binary: s?.binary ?? false,
    };
  });
}
