// Code-review forge abstraction: the operations the review feature needs from a
// git host, a registry of implementations, and origin-based selection. Node-only:
// imported by src/review.ts and src/api.ts (never by the browser bundle).
//
// Shared git helpers used by every forge live here too. Each implementation
// (src/gitlab.ts, src/github.ts) imports them; they never import this module's
// values at top level, so the import cycle is safe.

import { spawn } from 'node:child_process';
import type {
  DiffRefs,
  ForgeKind,
  ReviewChanges,
  ReviewComment,
  ReviewRequest,
} from './types';

/** The forge operations the review feature drives. */
export interface ReviewForge {
  readonly kind: ForgeKind;
  /** Full noun for prose: "merge request" / "pull request". */
  readonly label: string;
  /** Short label for badges and buttons: "MR" / "PR". */
  readonly shortLabel: string;

  /** Explicit setting wins over `origin`; null when no project/repo can be resolved. */
  resolveProject(repoPath: string): Promise<string | null>;

  /** Open requests for the resolved project/repo. */
  listRequests(repoPath: string): Promise<ReviewRequest[]>;

  /** One request plus its changed files and diff refs. */
  getChanges(repoPath: string, number: number): Promise<ReviewChanges>;

  /**
   * Make `changes.diffRefs.headSha` available to the read-only git tools, fetching
   * the hidden request ref first and falling back to the raw SHA. Writes only
   * objects and the hidden ref; never HEAD, the index, or the working tree.
   */
  ensureRefs(repoPath: string, changes: ReviewChanges): Promise<{ fetched: boolean }>;

  /**
   * Check out the request's source branch and pull it. Local only except the
   * final `git pull`; returns git's combined output. The branch is created from
   * the already-fetched hidden head ref when absent, so no second fetch is needed.
   */
  checkoutBranch(repoPath: string, iid: number, branch: string): Promise<string>;

  /**
   * Post one approved comment. Anchors to a line when possible and degrades to a
   * general comment otherwise. Returns the forge comment/discussion id.
   */
  postComment(
    repoPath: string,
    number: number,
    comment: ReviewComment,
    refs: DiffRefs,
  ): Promise<string>;

  /** Approve the request. */
  approve(repoPath: string, number: number): Promise<void>;

  /** Cheap authenticated probe for Settings "Test"; returns a username/login. */
  test(): Promise<string>;
}

// --- shared read-only git helpers (also used by src/review.ts) ---

/** The configured URL of a remote (default `origin`), or '' when absent. */
export function gitRemoteOrigin(repoPath: string, remote = 'origin'): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('git', ['remote', 'get-url', remote], {
      cwd: repoPath,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' },
    });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.on('error', () => resolve(''));
    child.on('close', (code) => resolve(code === 0 ? stdout.trim() : ''));
  });
}

/** Run a git command in the repo; rejects with stderr on nonzero exit. */
export function runGit(
  repoPath: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: repoPath,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        LC_ALL: 'C',
        GIT_TERMINAL_PROMPT: '0',
        ...extraEnv,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => reject(new Error(`git failed to start: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `git ${args[0]} exited ${code}`));
    });
  });
}

/** Whether a commit-ish already exists in the local object database. */
export async function hasCommit(repoPath: string, sha: string): Promise<boolean> {
  try {
    await runGit(repoPath, ['cat-file', '-e', `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Make `headSha` available locally by fetching `refSpec` into `hiddenRef`, then
 * falling back to fetching the SHA directly. Never touches HEAD, the index, or the
 * working tree, and does no network work when the commit is already present.
 */
export async function fetchHeadIntoHiddenRef(
  repoPath: string,
  headSha: string,
  refSpec: string,
  hiddenRef: string,
): Promise<{ fetched: boolean }> {
  const sha = headSha.trim();
  if (!sha) throw new Error('Request has no head SHA');
  if (await hasCommit(repoPath, sha)) return { fetched: false };

  const remotes = (await runGit(repoPath, ['remote']))
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const remote = remotes.includes('origin') ? 'origin' : remotes[0];
  if (!remote) throw new Error('No git remote configured to fetch the request commit from');

  try {
    await runGit(repoPath, ['fetch', '--no-tags', remote, `+${refSpec}:${hiddenRef}`]);
  } catch {
    // Hosts that don't expose request refs: fetch the SHA directly below.
  }
  if (!(await hasCommit(repoPath, sha))) {
    await runGit(repoPath, ['fetch', '--no-tags', remote, sha]);
  }
  if (!(await hasCommit(repoPath, sha))) {
    throw new Error(`Fetched request ref but ${sha} is still missing`);
  }
  return { fetched: true };
}

/** The hidden ref a request head is fetched into, per forge. */
export function hiddenHeadRef(forge: ForgeKind, iid: number): string {
  return forge === 'github' ? `refs/liana/pr/${iid}` : `refs/liana/mr/${iid}`;
}

/** Whether a local branch of this exact name exists. */
async function hasLocalBranch(repoPath: string, branch: string): Promise<boolean> {
  try {
    await runGit(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** The remote to use: `origin`, else the first configured one, or null. */
async function pickRemote(repoPath: string): Promise<string | null> {
  const remotes = (await runGit(repoPath, ['remote']))
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  return remotes.includes('origin') ? 'origin' : (remotes[0] ?? null);
}

/**
 * Check out a request's source branch and pull it. The branch is created from
 * the already-fetched hidden head ref when it does not exist locally, then
 * updated with `git pull`; it never rewrites history. Only `git checkout` and
 * `git pull` are used, with the same no-prompt environment as push/pull.
 */
export async function checkoutRequestBranch(
  repoPath: string,
  branch: string,
  hiddenRef: string,
): Promise<string> {
  const name = branch.trim();
  if (!name) throw new Error('The request has no source branch');
  // Reuse the checkout name rules: reject anything git would misread as an option.
  if (!/^[^\s~^:?*[\\]+$/.test(name) || name.startsWith('-') || name.includes('..')) {
    throw new Error(`Invalid branch name: ${name}`);
  }
  const remote = await pickRemote(repoPath);
  if (!remote) throw new Error('No git remote configured');

  if (await hasLocalBranch(repoPath, name)) {
    await runGit(repoPath, ['checkout', name]);
  } else if (await hasCommit(repoPath, hiddenRef).catch(() => false)) {
    // The review already fetched the head commit; branch from it without a second fetch.
    await runGit(repoPath, ['checkout', '-b', name, hiddenRef]);
  } else if (await hasCommit(repoPath, `${remote}/${name}`).catch(() => false)) {
    await runGit(repoPath, ['checkout', '-b', name, '--track', `${remote}/${name}`]);
  } else {
    throw new Error(
      `Branch "${name}" is not available locally; load the request (which fetches its head) first`,
    );
  }
  return (await runGit(repoPath, ['pull', remote, name])).trim();
}

/** Turn a git remote URL into an `owner/name` (or `group/project`) path, or null. */
export function projectFromRemote(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  // scp-like: git@host:owner/name.git
  const scp = trimmed.match(/^[^@]+@[^:]+:(.+?)(?:\.git)?$/);
  if (scp?.[1]) return scp[1].replace(/\.git$/, '');
  try {
    const u = new URL(trimmed);
    return u.pathname.replace(/^\/+/, '').replace(/\.git$/, '') || null;
  } catch {
    return null;
  }
}

const FORGE_LABELS: Record<ForgeKind, string> = {
  gitlab: 'merge request',
  github: 'pull request',
};
const FORGE_SHORT: Record<ForgeKind, string> = { gitlab: 'MR', github: 'PR' };

/** Labels for a forge kind, for prompts and UI. */
export function forgeLabel(kind: ForgeKind): string {
  return FORGE_LABELS[kind];
}

/** Short labels for a forge kind. */
export function forgeShortLabel(kind: ForgeKind): string {
  return FORGE_SHORT[kind];
}

export type { DiffRefs, ReviewChanges, ReviewComment, ReviewRequest };
