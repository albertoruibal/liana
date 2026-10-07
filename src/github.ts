// GitHub / GitHub Enterprise Server REST client behind the ReviewForge interface.
// Node-only: imported by src/forges.ts (itself imported only by src/review.ts /
// src/api.ts). Never by the browser bundle.
//
// Auth is a Bearer PAT (fine-grained: Contents read, Pull requests read+write; or
// classic with `repo`). Base URL defaults to https://api.github.com; for GHES set
// https://<host>/api/v3. All HTTP runs with an AbortController timeout and surfaces
// the upstream error body unchanged. The token is never logged.

import {
  fetchHeadIntoHiddenRef,
  gitRemoteOrigin,
  projectFromRemote,
  type ReviewForge,
} from './forge';
import { githubConfig } from './settings';
import type {
  DiffRefs,
  ReviewChanges,
  ReviewComment,
  ReviewFile,
  ReviewRequest,
} from './types';

const GITHUB_TIMEOUT_MS = 30_000;
/** Cap on PR file pages (100 files/page) so a huge PR can't exhaust time/memory. */
const MAX_FILE_PAGES = 30;

async function githubFetch(method: string, urlPath: string, body?: unknown): Promise<unknown> {
  const cfg = githubConfig();
  const url = `${cfg.baseUrl}${urlPath}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${cfg.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      // Surface GitHub's own message unchanged.
      let message = text;
      try {
        const parsed = JSON.parse(text) as { message?: unknown; errors?: unknown };
        if (parsed.message) {
          message = JSON.stringify(parsed.message);
          if (parsed.errors) message += ` ${JSON.stringify(parsed.errors)}`;
        }
      } catch {
        // keep raw text
      }
      const err = new Error(`GitHub ${method} ${urlPath} → ${res.status}: ${message}`) as Error & {
        status?: number;
      };
      err.status = res.status;
      throw err;
    }
    return text ? (JSON.parse(text) as unknown) : {};
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`GitHub request timed out after ${GITHUB_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Extract the HTTP status attached to a `githubFetch` error, or null. */
function errorStatus(err: unknown): number | null {
  if (err instanceof Error && 'status' in err) {
    const status = (err as { status?: unknown }).status;
    return typeof status === 'number' ? status : null;
  }
  return null;
}

function encodeRepo(repo: string): string {
  // `owner/name`: encode each segment, keep the slash.
  return repo
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
}

function mapPr(raw: Record<string, unknown>): ReviewRequest {
  const head = (typeof raw.head === 'object' && raw.head !== null ? raw.head : {}) as Record<
    string,
    unknown
  >;
  const base = (typeof raw.base === 'object' && raw.base !== null ? raw.base : {}) as Record<
    string,
    unknown
  >;
  const user = (typeof raw.user === 'object' && raw.user !== null ? raw.user : {}) as Record<
    string,
    unknown
  >;
  const state = typeof raw.state === 'string' ? raw.state : '';
  return {
    iid: typeof raw.number === 'number' ? raw.number : 0,
    title: typeof raw.title === 'string' ? raw.title : '',
    author: typeof user.login === 'string' ? user.login : '',
    sourceBranch: typeof head.ref === 'string' ? head.ref : '',
    targetBranch: typeof base.ref === 'string' ? base.ref : '',
    // Normalise to the GitLab spelling so the UI badge reads consistently.
    state: state === 'open' ? 'opened' : state,
    webUrl: typeof raw.html_url === 'string' ? raw.html_url : '',
    updatedAt: typeof raw.updated_at === 'string' ? raw.updated_at : '',
    draft: raw.draft === true,
  };
}

/** Resolve the GitHub repo to use: explicit setting wins over `origin`. */
async function resolveProject(repoPath: string): Promise<string | null> {
  const cfg = githubConfig();
  if (cfg.repo.trim()) return cfg.repo.trim().replace(/^\/+|\/+$/g, '');
  const origin = await gitRemoteOrigin(repoPath);
  return projectFromRemote(origin);
}

/** List open pull requests for the repository's GitHub repo. */
async function listPullRequests(repoPath: string): Promise<ReviewRequest[]> {
  const repo = await resolveProject(repoPath);
  if (!repo) throw new Error('No GitHub repo: set one in Settings or add an `origin` remote');
  const raw = (await githubFetch(
    'GET',
    `/repos/${encodeRepo(repo)}/pulls?state=open&sort=updated&direction=desc&per_page=50`,
  )) as unknown;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
    .map(mapPr);
}

/** Fetch every page of a PR's changed files (patch omitted by GitHub for binaries). */
async function fetchPullFiles(repo: string, number: number): Promise<ReviewFile[]> {
  const files: ReviewFile[] = [];
  for (let page = 1; page <= MAX_FILE_PAGES; page++) {
    const raw = (await githubFetch(
      'GET',
      `/repos/${encodeRepo(repo)}/pulls/${number}/files?per_page=100&page=${page}`,
    )) as unknown;
    if (!Array.isArray(raw) || raw.length === 0) break;
    for (const item of raw) {
      if (typeof item !== 'object' || item === null) continue;
      const f = item as Record<string, unknown>;
      const newPath = typeof f.filename === 'string' ? f.filename : '';
      const oldPath = typeof f.previous_filename === 'string' ? f.previous_filename : newPath;
      const status = typeof f.status === 'string' ? f.status : '';
      files.push({
        oldPath,
        newPath,
        newFile: status === 'added',
        deletedFile: status === 'removed',
        renamedFile: status === 'renamed',
        diff: typeof f.patch === 'string' ? f.patch : '',
      });
    }
    if (raw.length < 100) break;
  }
  return files;
}

/** Fetch one PR with its changed files and diff refs. */
async function getPullRequestChanges(repoPath: string, number: number): Promise<ReviewChanges> {
  const repo = await resolveProject(repoPath);
  if (!repo) throw new Error('No GitHub repo: set one in Settings or add an `origin` remote');
  const enc = encodeRepo(repo);
  const raw = (await githubFetch('GET', `/repos/${enc}/pulls/${number}`)) as Record<
    string,
    unknown
  >;
  const base = (typeof raw.base === 'object' && raw.base !== null ? raw.base : {}) as Record<
    string,
    unknown
  >;
  const head = (typeof raw.head === 'object' && raw.head !== null ? raw.head : {}) as Record<
    string,
    unknown
  >;
  const baseSha = typeof base.sha === 'string' ? base.sha : '';
  const headSha = typeof head.sha === 'string' ? head.sha : '';
  const files = await fetchPullFiles(repo, number);
  return {
    forge: 'github',
    mr: mapPr(raw),
    files,
    // GitHub has no start_sha; anchoring only uses headSha, so reuse baseSha.
    diffRefs: { baseSha, headSha, startSha: baseSha },
  };
}

/** Make a PR's head commit available by fetching `refs/pull/<n>/head`. */
async function ensurePullRequestRefs(
  repoPath: string,
  changes: ReviewChanges,
): Promise<{ fetched: boolean }> {
  return fetchHeadIntoHiddenRef(
    repoPath,
    changes.diffRefs.headSha,
    `refs/pull/${changes.mr.iid}/head`,
    `refs/liana/pr/${changes.mr.iid}`,
  );
}

/** General (non-line) comment on the PR's issue thread. */
async function postIssueComment(repo: string, number: number, body: string): Promise<string> {
  const raw = (await githubFetch('POST', `/repos/${encodeRepo(repo)}/issues/${number}/comments`, {
    body,
  })) as Record<string, unknown>;
  return typeof raw.id === 'number' ? String(raw.id) : '';
}

/** Post one approved comment, anchoring to a line when possible. */
async function createReviewComment(
  repoPath: string,
  number: number,
  comment: ReviewComment,
  refs: DiffRefs,
): Promise<string> {
  const repo = await resolveProject(repoPath);
  if (!repo) throw new Error('No GitHub repo: set one in Settings or add an `origin` remote');
  const enc = encodeRepo(repo);

  const newLine = comment.newLine;
  const oldLine = comment.oldLine;
  // No head SHA or no line anchor: GitHub can't position it, so post a general
  // issue comment rather than failing.
  if (!refs.headSha || (newLine === null && oldLine === null)) {
    return postIssueComment(repo, number, comment.body);
  }

  const body: Record<string, unknown> = {
    body: comment.body,
    commit_id: refs.headSha,
    path: comment.filePath,
  };
  if (newLine !== null) {
    body.line = newLine;
    body.side = 'RIGHT';
    // Both sides present → try a multi-line range; if GitHub rejects it the retry
    // below falls back to a single RIGHT line.
    if (oldLine !== null && oldLine < newLine) {
      body.start_line = oldLine;
      body.start_side = 'LEFT';
    }
  } else {
    body.line = oldLine;
    body.side = 'LEFT';
  }

  try {
    const raw = (await githubFetch('POST', `/repos/${enc}/pulls/${number}/comments`, body)) as Record<
      string,
      unknown
    >;
    if (typeof raw.id === 'number') return String(raw.id);
    return typeof raw.html_url === 'string' ? raw.html_url : '';
  } catch (err) {
    const status = errorStatus(err);
    // 422 (stale commit_id / line outside the diff / range across hunks) and 404
    // (commit unknown) degrade to a general comment so the review is never lost.
    if (status !== 422 && status !== 404) throw err;
    // Retry once as a single RIGHT line when only the range was the problem.
    if (newLine !== null && body.start_line !== undefined) {
      try {
        const single = {
          body: comment.body,
          commit_id: refs.headSha,
          path: comment.filePath,
          line: newLine,
          side: 'RIGHT',
        };
        const raw = (await githubFetch(
          'POST',
          `/repos/${enc}/pulls/${number}/comments`,
          single,
        )) as Record<string, unknown>;
        return typeof raw.id === 'number' ? String(raw.id) : '';
      } catch {
        // Fall through to the issue comment.
      }
    }
    return postIssueComment(repo, number, comment.body);
  }
}

/** Approve a pull request by submitting an APPROVE review. */
async function approvePullRequest(repoPath: string, number: number): Promise<void> {
  const repo = await resolveProject(repoPath);
  if (!repo) throw new Error('No GitHub repo: set one in Settings or add an `origin` remote');
  await githubFetch('POST', `/repos/${encodeRepo(repo)}/pulls/${number}/reviews`, {
    event: 'APPROVE',
    body: 'Approved from Liana.',
  });
}

/** Cheap authenticated call used by the settings "Test" button. */
async function testGitHub(): Promise<string> {
  const raw = (await githubFetch('GET', '/user')) as Record<string, unknown>;
  return typeof raw.login === 'string' ? raw.login : 'authenticated';
}

export const githubForge: ReviewForge = {
  kind: 'github',
  label: 'pull request',
  shortLabel: 'PR',
  resolveProject,
  listRequests: listPullRequests,
  getChanges: getPullRequestChanges,
  ensureRefs: ensurePullRequestRefs,
  postComment: createReviewComment,
  approve: approvePullRequest,
  test: testGitHub,
};
