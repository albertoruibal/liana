// Pure parsing for `git show --name-status`/`--numstat`/`--raw` output.
// Shared by the browser mirror (src/git.ts) and the Node backend (src/api.ts) so
// the two copies of the git wrappers stay behaviorally identical. Node-free.

import type { CommitFile, ConflictEntry, ConflictType } from './types';

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

const GITLINK_MODE = '160000';

/**
 * Parse `git show --raw -z` into a destination path → source mode map. Only the
 * destination mode is kept, which is what distinguishes a gitlink (mode 160000,
 * a submodule) from a regular file in the resulting tree. Tokens are
 * `:oldmode newmode oldsha newsha status\0path\0` (`path\0oldpath\0` for renames).
 */
export function parseRawModes(out: string): Map<string, string> {
  const modes = new Map<string, string>();
  const tokens = out.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token || !token.startsWith(':')) continue;
    const meta = token.slice(1).trim().split(/\s+/);
    const newMode = meta[1];
    const status = meta[4] ?? '';
    const path = tokens[i + 1] ?? '';
    i += 1;
    if (status[0] === 'R' || status[0] === 'C') i += 1; // skip the rename source
    if (path && newMode) modes.set(path, newMode);
  }
  return modes;
}

/** True when a raw mode string denotes a gitlink / submodule entry. */
export function isGitlinkMode(mode: string | undefined): boolean {
  return mode === GITLINK_MODE;
}

/**
 * Zip the `--name-status`, `--numstat`, and `--raw` views of the same `git show`
 * (same order) into `CommitFile` records.
 */
export function parseCommitFiles(
  nameStatusOut: string,
  numstatOut: string,
  rawOut = '',
): CommitFile[] {
  const names = parseNameStatus(nameStatusOut);
  const stats = parseNumstat(numstatOut);
  const modes = parseRawModes(rawOut);
  return names.map((n, i) => {
    const s = stats[i];
    const mode = modes.get(n.path);
    return {
      path: n.path,
      oldPath: n.oldPath,
      status: n.status,
      additions: s?.additions ?? null,
      deletions: s?.deletions ?? null,
      binary: s?.binary ?? false,
      isSubmodule: isGitlinkMode(mode),
    };
  });
}

const GITLINK_MODE_HEX = '160000';

/** Classify an unmerged path from which of the three index stages are populated. */
export function classifyConflict(hasBase: boolean, hasOurs: boolean, hasTheirs: boolean): ConflictType {
  // The normal three-way set is {1,2,3} both-modified, {2,3} both-added,
  // {1,3} deleted-by-us, {1,2} deleted-by-them.
  if (hasOurs && hasTheirs) return hasBase ? 'both-modified' : 'both-added';
  if (hasBase && hasOurs) return 'deleted-by-them';
  if (hasBase && hasTheirs) return 'deleted-by-us';
  // Degenerate stage sets (should not occur in a normal merge).
  if (hasOurs) return 'added-by-us';
  if (hasTheirs) return 'added-by-them';
  return 'both-modified';
}

interface ConflictStage {
  mode: string;
  hash: string;
}

/**
 * Parse `git ls-files -u -z` into one entry per conflicted path. Lines are
 * `<mode> <object> <stage>\t<path>` NUL-delimited; stages 1/2/3 are base/ours/theirs.
 */
export function parseUnmerged(out: string): ConflictEntry[] {
  const byPath = new Map<string, { base?: ConflictStage; ours?: ConflictStage; theirs?: ConflictStage }>();
  for (const token of out.split('\0')) {
    if (!token) continue;
    const tab = token.indexOf('\t');
    if (tab < 0) continue;
    const [mode = '', hash = '', stageStr = ''] = token.slice(0, tab).split(' ');
    const path = token.slice(tab + 1);
    if (!path) continue;
    const entry = byPath.get(path) ?? {};
    const stage: ConflictStage = { mode, hash };
    if (stageStr === '1') entry.base = stage;
    else if (stageStr === '2') entry.ours = stage;
    else if (stageStr === '3') entry.theirs = stage;
    byPath.set(path, entry);
  }
  const conflicts: ConflictEntry[] = [];
  for (const [path, s] of byPath) {
    const hasBase = !!s.base;
    const hasOurs = !!s.ours;
    const hasTheirs = !!s.theirs;
    conflicts.push({
      path,
      type: classifyConflict(hasBase, hasOurs, hasTheirs),
      baseHash: s.base?.hash ?? null,
      oursHash: s.ours?.hash ?? null,
      theirsHash: s.theirs?.hash ?? null,
      isSubmodule: [s.base, s.ours, s.theirs].some((stage) => stage?.mode === GITLINK_MODE_HEX),
    });
  }
  return conflicts;
}
