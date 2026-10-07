// GitLab REST client behind the ReviewForge interface. Node-only: imported by
// src/forges.ts (itself imported only by src/review.ts / src/api.ts) and by
// src/review.ts for the legacy test helper. Never by the browser bundle.
//
// All HTTP runs with an AbortController timeout and surfaces GitLab's own error
// body unchanged. The token is read from src/settings.ts and never logged.

import {
  fetchHeadIntoHiddenRef,
  gitRemoteOrigin,
  projectFromRemote,
  type ReviewForge,
} from './forge';
import { gitlabConfig } from './settings';
import type {
  DiffRefs,
  ReviewChanges,
  ReviewComment,
  ReviewFile,
  ReviewRequest,
} from './types';

const GITLAB_TIMEOUT_MS = 30_000;

async function gitlabFetch(
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<unknown> {
  const cfg = gitlabConfig();
  const url = `${cfg.baseUrl}${urlPath}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITLAB_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { 'PRIVATE-TOKEN': cfg.token };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      // Surface GitLab's own message unchanged.
      let message = text;
      try {
        const parsed = JSON.parse(text) as { message?: unknown; error?: unknown };
        if (parsed.message) message = JSON.stringify(parsed.message);
        else if (typeof parsed.error === 'string') message = parsed.error;
      } catch {
        // keep raw text
      }
      throw new Error(`GitLab ${method} ${urlPath} → ${res.status}: ${message}`);
    }
    return text ? (JSON.parse(text) as unknown) : {};
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`GitLab request timed out after ${GITLAB_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function encodeProject(project: string): string {
  return encodeURIComponent(project);
}

function mapMr(raw: Record<string, unknown>): ReviewRequest {
  return {
    iid: typeof raw.iid === 'number' ? raw.iid : 0,
    title: typeof raw.title === 'string' ? raw.title : '',
    author:
      typeof raw.author === 'object' && raw.author !== null
        ? String((raw.author as Record<string, unknown>).name ?? '')
        : '',
    sourceBranch: typeof raw.source_branch === 'string' ? raw.source_branch : '',
    targetBranch: typeof raw.target_branch === 'string' ? raw.target_branch : '',
    state: typeof raw.state === 'string' ? raw.state : '',
    webUrl: typeof raw.web_url === 'string' ? raw.web_url : '',
    updatedAt: typeof raw.updated_at === 'string' ? raw.updated_at : '',
    draft: raw.draft === true,
  };
}

/** Resolve the GitLab project to use: explicit setting wins over `origin`. */
async function resolveProject(repoPath: string): Promise<string | null> {
  const cfg = gitlabConfig();
  if (cfg.projectId.trim()) return cfg.projectId.trim();
  const origin = await gitRemoteOrigin(repoPath);
  return projectFromRemote(origin);
}

/** List open merge requests for the repository's GitLab project. */
async function listMergeRequests(repoPath: string): Promise<ReviewRequest[]> {
  const project = await resolveProject(repoPath);
  if (!project) throw new Error('No GitLab project: set one in Settings or add an `origin` remote');
  const raw = (await gitlabFetch(
    'GET',
    `/api/v4/projects/${encodeProject(project)}/merge_requests?state=opened&order_by=updated_at&per_page=50`,
  )) as unknown;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
    .map(mapMr);
}

/** Fetch one MR with its changed files and diff refs. */
async function getMergeRequestChanges(repoPath: string, iid: number): Promise<ReviewChanges> {
  const project = await resolveProject(repoPath);
  if (!project) throw new Error('No GitLab project: set one in Settings or add an `origin` remote');
  const enc = encodeProject(project);
  const raw = (await gitlabFetch(
    'GET',
    `/api/v4/projects/${enc}/merge_requests/${iid}/changes`,
  )) as Record<string, unknown>;

  const changesRaw = Array.isArray(raw.changes) ? raw.changes : [];
  const files: ReviewFile[] = changesRaw
    .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
    .map((c) => ({
      oldPath: typeof c.old_path === 'string' ? c.old_path : '',
      newPath: typeof c.new_path === 'string' ? c.new_path : '',
      newFile: c.new_file === true,
      deletedFile: c.deleted_file === true,
      renamedFile: c.renamed_file === true,
      diff: typeof c.diff === 'string' ? c.diff : '',
    }));

  const refsRaw = (typeof raw.diff_refs === 'object' && raw.diff_refs !== null
    ? raw.diff_refs
    : {}) as Record<string, unknown>;
  const diffRefs: DiffRefs = {
    baseSha: typeof refsRaw.base_sha === 'string' ? refsRaw.base_sha : '',
    headSha: typeof refsRaw.head_sha === 'string' ? refsRaw.head_sha : '',
    startSha: typeof refsRaw.start_sha === 'string' ? refsRaw.start_sha : '',
  };

  return { forge: 'gitlab', mr: mapMr(raw), files, diffRefs };
}

/** Fetch an MR head into `refs/liana/mr/<iid>`, with the SHA fallback. */
async function ensureMergeRequestRefs(
  repoPath: string,
  changes: ReviewChanges,
): Promise<{ fetched: boolean }> {
  return fetchHeadIntoHiddenRef(
    repoPath,
    changes.diffRefs.headSha,
    `refs/merge-requests/${changes.mr.iid}/head`,
    `refs/liana/mr/${changes.mr.iid}`,
  );
}

/** Create a review comment as a discussion, positioned to a line when possible. */
async function createDiscussion(
  repoPath: string,
  iid: number,
  comment: ReviewComment,
  refs: DiffRefs,
): Promise<string> {
  const project = await resolveProject(repoPath);
  if (!project) throw new Error('No GitLab project: set one in Settings or add an `origin` remote');
  const enc = encodeProject(project);
  const body: Record<string, unknown> = { body: comment.body };

  const newLine = comment.newLine;
  const oldLine = comment.oldLine;
  if (refs.headSha && (newLine !== null || oldLine !== null)) {
    const position: Record<string, unknown> = {
      position_type: 'text',
      base_sha: refs.baseSha,
      head_sha: refs.headSha,
      start_sha: refs.startSha,
      new_path: comment.filePath,
      old_path: comment.filePath,
    };
    // A new-side line anchors additions/context; old-side anchors deletions.
    if (newLine !== null) position.new_line = newLine;
    if (oldLine !== null) position.old_line = oldLine;
    body.position = position;
  }

  const raw = (await gitlabFetch(
    'POST',
    `/api/v4/projects/${enc}/merge_requests/${iid}/discussions`,
    body,
  )) as Record<string, unknown>;
  return typeof raw.id === 'string' ? raw.id : '';
}

/** Approve a merge request. */
async function approveMergeRequest(repoPath: string, iid: number): Promise<void> {
  const project = await resolveProject(repoPath);
  if (!project) throw new Error('No GitLab project: set one in Settings or add an `origin` remote');
  await gitlabFetch(
    'POST',
    `/api/v4/projects/${encodeProject(project)}/merge_requests/${iid}/approve`,
  );
}

/** Cheap authenticated call used by the settings "Test" button. */
async function testGitLab(): Promise<string> {
  const raw = (await gitlabFetch('GET', '/api/v4/user')) as Record<string, unknown>;
  return typeof raw.username === 'string' ? raw.username : 'authenticated';
}

export const gitlabForge: ReviewForge = {
  kind: 'gitlab',
  label: 'merge request',
  shortLabel: 'MR',
  resolveProject,
  listRequests: listMergeRequests,
  getChanges: getMergeRequestChanges,
  ensureRefs: ensureMergeRequestRefs,
  postComment: createDiscussion,
  approve: approveMergeRequest,
  test: testGitLab,
};
