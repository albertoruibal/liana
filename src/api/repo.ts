// Log / status / commit reads and writes. Node-only. Mirrored by src/git/repo.ts.

import path from 'node:path';
import { gitRun, UNIT } from './exec';
import type {
  BranchInfo,
  GitCommit,
  RepoState,
  RepoStatus,
  StashInfo,
  StatusEntry,
} from '../types';

/** Parse %D decoration string into typed ref names (HEAD handled separately). */
export function parseDecorations(decorated: string, commit: GitCommit): void {
  if (!decorated.trim()) return;
  for (const item of decorated.split(', ').map((s) => s.trim())) {
    let ref: GitCommit['refs'][number];
    if (item === 'HEAD') {
      ref = { name: 'HEAD', kind: 'head' };
    } else if (item.startsWith('HEAD -> ')) {
      const branch = item.slice('HEAD -> '.length).replace(/^refs\/heads\//, '');
      commit.refs.push({ name: 'HEAD', kind: 'head' });
      ref = { name: branch, kind: 'local' };
    } else if (item.startsWith('tag: ')) {
      ref = { name: item.slice('tag: '.length).replace(/^refs\/tags\//, ''), kind: 'tag' };
    } else if (item.startsWith('refs/remotes/')) {
      ref = { name: item.slice('refs/remotes/'.length), kind: 'remote' };
    } else if (item.startsWith('refs/heads/')) {
      ref = { name: item.slice('refs/heads/'.length), kind: 'local' };
    } else {
      // Short %D falls back to the default remote as "origin/...".
      ref = { name: item, kind: item.startsWith('origin/') ? 'remote' : 'local' };
    }
    commit.refs.push(ref);
  }
}

export async function loadLog(
  repoPath: string,
  limit: number,
  stashes?: Map<string, StashInfo>,
): Promise<GitCommit[]> {
  const fmt = ['%H', '%P', '%an', '%at', '%s', '%D'].join(UNIT);
  const args = [
    'log',
    '--all',
    '--date-order',
    '--decorate=full',
    `--pretty=format:${fmt}`,
    `--max-count=${limit}`,
    ...(stashes ? [...stashes.keys()] : []),
  ];
  const out = await gitRun(repoPath, args);
  const commits: GitCommit[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [hash = '', parents = '', author = '', ts = '', subject = '', decorated = ''] =
      line.split(UNIT);
    const stash = stashes?.get(hash);
    const commit: GitCommit = {
      hash,
      // Stash WIP commits expose [base, index, (untracked)]; only the base is a
      // real history commit, so drop the synthetic parents to avoid fake merges.
      parents: stash ? [...stash.parents] : parents ? parents.split(' ') : [],
      author,
      timestamp: Number(ts) || 0,
      subject: stash ? stash.message : subject,
      refs: [],
    };
    if (stash) {
      commit.isStash = true;
      commit.stash = stash;
      commit.refs.push({ name: stash.selector, kind: 'stash' });
    } else {
      parseDecorations(decorated, commit);
    }
    commits.push(commit);
  }
  return commits;
}

/**
 * Read `git stash list`. Returns stash metadata keyed by WIP commit hash plus the
 * set of synthetic index/untracked commits that must be hidden from the graph.
 */
export async function loadStashes(
  repoPath: string,
): Promise<{ stashes: Map<string, StashInfo>; hidden: Set<string> }> {
  const fmt = ['%H', '%gd', '%gs', '%ct', '%an', '%P'].join(UNIT);
  const out = await gitRun(repoPath, ['stash', 'list', `--format=${fmt}`]);
  const stashes = new Map<string, StashInfo>();
  const hidden = new Set<string>();
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [hash = '', selector = '', subject = '', ts = '', author = '', parentList = ''] =
      line.split(UNIT);
    if (!hash) continue;
    const parents = parentList ? parentList.split(' ') : [];
    for (const parent of parents.slice(1)) hidden.add(parent);
    // "On <branch>: <message>", or just the raw subject for e.g. "WIP on ...".
    const m = /^On ([^:]+): (.*)$/.exec(subject);
    stashes.set(hash, {
      selector,
      hash,
      message: m?.[2] ?? subject,
      branch: m?.[1] ?? null,
      parents: parents.slice(0, 1),
      author,
      timestamp: Number(ts) || 0,
    });
  }
  return { stashes, hidden };
}

/**
 * Read every ref once. Returns the branch view plus a fingerprint over *all*
 * refs (heads, remotes, tags, stash) so a cached log can be invalidated when
 * any of them moves — tags included, since they decorate the graph too.
 */
export async function loadRepoRefs(
  repoPath: string,
): Promise<{ state: RepoState; fingerprint: string }> {
  const [refsOut, symbolicOut] = await Promise.all([
    gitRun(repoPath, ['for-each-ref', '--format=%(refname)%00%(objectname)']),
    gitRun(repoPath, ['rev-parse', '--symbolic-full-name', 'HEAD']).catch(() => ''),
  ]);
  // "refs/heads/main" when on a branch, "HEAD" when detached
  const symbolic = symbolicOut.trim();
  const detachedHead = !symbolic.startsWith('refs/heads/');
  const headBranch = detachedHead ? null : symbolic.replace(/^refs\/heads\//, '');

  const branches: BranchInfo[] = [];
  for (const line of refsOut.split('\n')) {
    if (!line.trim()) continue;
    const [refname = '', hash = ''] = line.split('\x00');
    if (!refname.startsWith('refs/heads/') && !refname.startsWith('refs/remotes/')) continue;
    branches.push({
      name: refname.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\//, ''),
      hash,
      isHead: !detachedHead && refname === `refs/heads/${headBranch}`,
      isRemote: refname.startsWith('refs/remotes/'),
    });
  }

  const name = path.basename(repoPath);
  return {
    state: { name, headBranch, detachedHead, branches },
    // `refsOut` lists every ref (heads, remotes, tags, stash) with its object id,
    // so comparing it catches any ref move. HEAD name covers unborn/detached.
    fingerprint: `${detachedHead ? 'HEAD' : headBranch}\n${refsOut}`,
  };
}

export async function loadStatus(repoPath: string): Promise<RepoStatus> {
  const out = await gitRun(repoPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const tokens = out.split('\0');
  const entries: StatusEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const line = tokens[i];
    if (!line) continue;
    const xy = line.slice(0, 2);
    const p = line.slice(3);
    if (!p) continue;
    // In -z mode rename/copy entries are `XY <to>\0<from>\0`; the extra
    // `<from>` token is the rename source, not a status line.
    let oldPath: string | null = null;
    if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') {
      if (i + 1 < tokens.length) {
        oldPath = tokens[i + 1] || null;
        i++;
      }
    }
    entries.push({ stagedX: xy[0] ?? ' ', unstagedY: xy[1] ?? ' ', path: p, oldPath });
  }
  return { entries };
}

/** True when HEAD resolves (false on an unborn branch, e.g. after `git init`). */
export async function headExists(repoPath: string): Promise<boolean> {
  try {
    await gitRun(repoPath, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

/** Number of uncommitted (staged or unstaged) entries in the working tree. */
export async function dirtyCount(repoPath: string): Promise<number> {
  return (await loadStatus(repoPath)).entries.length;
}

/** Guard for operations git refuses to run on a dirty tree; returns an error string or null. */
export async function dirtyGuard(repoPath: string, op: string): Promise<string | null> {
  const n = await dirtyCount(repoPath);
  if (n === 0) return null;
  const changes = n === 1 ? 'change' : 'changes';
  return `${n} uncommitted ${changes} — commit or stash before ${op}`;
}

/**
 * Commit an explicit set of paths. `files` is intersected with the live status,
 * so callers can't stage paths outside the working tree. Checked files are
 * staged (`add -A`), and files already staged but not selected are unstaged, so
 * the commit contains exactly the selected set.
 */
export async function createCommit(
  repoPath: string,
  message: string,
  files: string[],
): Promise<string> {
  const status = await loadStatus(repoPath);
  const selected = new Set(files);
  const toStage = status.entries.filter((e) => selected.has(e.path)).map((e) => e.path);
  const toUnstage = status.entries
    .filter((e) => !selected.has(e.path) && e.stagedX !== ' ' && e.stagedX !== '?')
    .map((e) => e.path);
  if (toUnstage.length > 0) {
    if (await headExists(repoPath)) {
      await gitRun(repoPath, ['reset', '-q', '--', ...toUnstage]);
    } else {
      // No HEAD yet: `reset` has nothing to reset against, so drop the index entries.
      await gitRun(repoPath, ['rm', '--cached', '-r', '--', ...toUnstage]);
    }
  }
  if (toStage.length > 0) await gitRun(repoPath, ['add', '-A', '--', ...toStage]);
  await gitRun(repoPath, ['commit', '-m', message]);
  return (await gitRun(repoPath, ['rev-parse', 'HEAD'])).trim();
}
