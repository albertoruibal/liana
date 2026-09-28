// All git plumbing lives here. Thin wrappers over the git CLI — no native deps.
// Every command runs with -c advice.* settings disabled so stderr stays clean,
// and maxDepth guards the recursion-free code paths below.

import { spawn } from 'node:child_process';
import type { BranchInfo, GitCommit, RepoState, RepoStatus, StatusEntry } from './types';

export class GitError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
  ) {
    super(message);
  }
}

/** Run a git command in `repoPath`; resolves stdout, rejects GitError on nonzero exit. */
export function git(repoPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: repoPath,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        // Keep output stable regardless of user locale/config
        LC_ALL: 'C',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => reject(new GitError(`git failed to start: ${err.message}`, stderr)));
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new GitError(`git ${args[0]} failed (exit ${code})`, stderr.trim()));
    });
  });
}

const UNIT = '\x1f'; // field separator for --pretty format

export async function isGitRepo(repoPath: string): Promise<boolean> {
  try {
    await git(repoPath, ['rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}

/** Parse %D decoration string into display ref names (HEAD handled separately). */
function parseDecorations(decorated: string, commit: GitCommit): void {
  if (!decorated.trim()) return;
  for (const item of decorated.split(', ').map((s) => s.trim())) {
    if (item === 'HEAD') {
      commit.refs.push('HEAD');
    } else if (item.startsWith('HEAD -> ')) {
      commit.refs.push('HEAD');
      const branch = item.slice('HEAD -> '.length).replace(/^refs\/heads\//, '');
      commit.refs.push(branch);
    } else if (item.startsWith('tag: ')) {
      commit.refs.push(item.slice('tag: '.length).replace(/^refs\/tags\//, ''));
    } else {
      commit.refs.push(
        item.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\//, 'origin/'),
      );
    }
  }
}

export async function loadLog(repoPath: string, limit = 500): Promise<GitCommit[]> {
  const fmt = ['%H', '%P', '%an', '%at', '%s', '%D'].join(UNIT);
  const out = await git(repoPath, [
    'log',
    '--all',
    '--date-order',
    `--pretty=format:${fmt}`,
    `--max-count=${limit}`,
  ]);
  const commits: GitCommit[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [hash = '', parents = '', author = '', ts = '', subject = '', decorated = ''] =
      line.split(UNIT);
    const commit: GitCommit = {
      hash,
      parents: parents ? parents.split(' ') : [],
      author,
      timestamp: Number(ts) || 0,
      subject,
      refs: [],
    };
    parseDecorations(decorated, commit);
    commits.push(commit);
  }
  return commits;
}

export async function loadRepoState(repoPath: string): Promise<RepoState> {
  const [headOut, branchOut, nameOut] = await Promise.all([
    git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD', '--symbolic-full-name', 'HEAD']),
    git(repoPath, ['for-each-ref', '--format=%(refname)%00%(objectname)']),
    git(repoPath, ['basename', '--', repoPath]).catch(() => repoPath),
  ]);

  // "refs/heads/main" when on a branch, "HEAD" when detached
  const symbolic = headOut.trim().split('\n')[1] ?? '';
  const detachedHead = !symbolic.startsWith('refs/heads/');
  const headBranch = detachedHead ? null : symbolic.replace(/^refs\/heads\//, '');

  const branches: BranchInfo[] = [];
  for (const line of branchOut.split('\n')) {
    if (!line.trim()) continue;
    const [refname = '', hash = ''] = line.split('\x00');
    if (!refname.startsWith('refs/heads/') && !refname.startsWith('refs/remotes/')) continue;
    branches.push({
      name: refname.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\//, 'origin/'),
      hash,
      isHead: !detachedHead && refname === `refs/heads/${headBranch}`,
      isRemote: refname.startsWith('refs/remotes/'),
    });
  }

  const name = nameOut.trim().split('/').pop() || repoPath;
  return { name, headBranch, detachedHead, branches };
}

export async function loadStatus(repoPath: string): Promise<RepoStatus> {
  const out = await git(repoPath, ['status', '--porcelain=v1', '--untracked-files=all']);
  const entries: StatusEntry[] = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const code = line.slice(0, 2);
    const path = line.slice(3);
    if (!path) continue;
    entries.push({
      code: code === '??' ? '??' : code[1] !== ' ' && code[1] !== '?' ? code[1]! : code[0]!,
      path,
      staged: code[0] !== ' ' && code !== '??',
    });
  }
  return { entries };
}

/** Stage everything and create a commit. Returns the new commit hash. */
export async function commitAll(repoPath: string, message: string): Promise<string> {
  await git(repoPath, ['add', '-A']);
  const out = await git(repoPath, ['commit', '-m', message]);
  const hash = await git(repoPath, ['rev-parse', 'HEAD']);
  if (!out.includes('created') && !hash) throw new GitError('commit produced no hash', out);
  return hash.trim();
}

/** Rebase the current branch onto `onto`. Uncommitted changes are not allowed by git. */
export async function rebaseOnto(repoPath: string, onto: string): Promise<string> {
  const out = await git(repoPath, ['rebase', onto]);
  return out.trim();
}

/** Cherry-pick `ref` onto the current branch. */
export async function cherryPick(repoPath: string, ref: string): Promise<string> {
  const out = await git(repoPath, ['cherry-pick', ref]);
  return out.trim();
}

/** List local branches with head marker, for the checkout menu. */
export async function checkoutBranch(repoPath: string, name: string): Promise<void> {
  await git(repoPath, ['checkout', name]);
}