// Transport-agnostic git backend: all /api route logic, no HTTP framework.
// Node-only — never import this from the renderer bundle (see AGENTS.md).
// `dev.ts` wraps `handle` in Vite Connect middleware; `electron/server.ts`
// wraps it in node:http. Wrapper changes must be mirrored in `src/git/`.

import path from 'node:path';
import { INTERACTIVE_REBASE_ENABLED } from '../config';
import {
  cancelReviewJob,
  createDiscussion,
  deleteReviewSession,
  generateCommitMessage,
  getReviewJob,
  listReviewSessions,
  loadReviewSession,
  pauseReviewJob,
  resumeReview,
  reviewJobRepo,
  saveReviewSessionComments,
  startReview,
  testForge,
  testGitLab,
  testProvider,
} from '../review';
import { forgeByKind, resolveForge } from '../forges';
import { markInterruptedSessions } from '../sessions';
import { applyConflictFix, proposeConflictFix } from '../conflict-fix';
import { activeProvider, commitRule, providerById, publicSettings, saveSettings } from '../settings';
import type {
  ConflictEntry,
  GitCommit,
  MergeOperation,
  RebaseTodoItem,
  ResetMode,
  ReviewComment,
  ReviewRuleConfig,
  StatusEntry,
  SubmoduleInfo,
} from '../types';
import { gitRun, repoActivity, GitError } from './exec';
import { loadLog, loadStashes, loadRepoRefs, loadStatus, createCommit, dirtyGuard } from './repo';
import { rebaseOnto, mergeBranch, cherryPick, revert } from './operations';
import {
  loadMergeState,
  loadConflicts,
  loadConflictFile,
  writeWorkingFile,
  resolveConflict,
  continueOperation,
  abortOperation,
  skipOperation,
} from './conflicts';
import {
  loadSubmodules,
  submoduleUpdate,
  submoduleSync,
  submoduleAdd,
  submoduleDeinit,
  loadSubmoduleLog,
} from './submodules';
import { selectedWorktreeDiffs, commitFiles, commitPatch, worktreePatch, fileContents } from './diffs';
import { loadRebasePlan, executeRebase } from './rebase';
import {
  validRefName,
  checkoutBranch,
  createBranch,
  deleteBranch,
  deleteRemoteBranchPush,
  createTag,
  deleteTag,
} from './branches';
import { loadRemoteStatus, pushBranch, pullBranch, testRemote } from './remotes';
import { resetBranch, RESET_MODES } from './reset';
import { resolveStash, createStash, applyStash, dropStash } from './stash';
import { resolveOpenRepo } from './open';

// --- HTTP-agnostic request handling ---

export interface ApiResponse {
  status: number;
  body: unknown;
}

/** A repository the server can serve, addressed by opaque `id` on each request. */
export interface RepoEntry {
  id: string;
  path: string;
  name: string;
}

export interface Api {
  handle(route: string, method: string, rawBody: string, repoId?: string): Promise<ApiResponse>;
}

export function createApi(defaultRepo: string | null): Api {
  // Sessions left `running` by a previous process are resumable, not hung.
  markInterruptedSessions();
  // Validated repositories, keyed by a per-process opaque id. The client owns the
  // tab list; the server only maps ids → absolute paths for the life of the process.
  const repos = new Map<string, { path: string; name: string }>();
  let nextId = 1;

  // Parsed log cache, keyed by repo id. `git log --all` is the most expensive
  // read on `/state`; it only changes when a ref (or the stash list) moves, so
  // fingerprint the refs and reuse the parsed commits otherwise. Status and
  // remote status are always re-read since they change without refs moving.
  const logCache = new Map<string, { fingerprint: string; commits: GitCommit[] }>();

  function register(abs: string): RepoEntry {
    for (const [id, entry] of repos) {
      if (entry.path === abs) return { id, path: entry.path, name: entry.name };
    }
    const id = `r${nextId++}`;
    const name = path.basename(abs);
    repos.set(id, { path: abs, name });
    return { id, path: abs, name };
  }

  // `defaultRepo` (LIANA_REPO / Electron launch) is validated lazily on first list.
  let seeded = false;
  async function ensureDefault(): Promise<void> {
    if (seeded) return;
    seeded = true;
    if (!defaultRepo) return;
    const abs = await resolveOpenRepo(defaultRepo);
    if (abs) register(abs);
  }

  async function handle(
    route: string,
    method: string,
    rawBody: string,
    repoId?: string,
  ): Promise<ApiResponse> {
    try {
      if (route === '/repos' && method === 'GET') {
        await ensureDefault();
        const entries: RepoEntry[] = [...repos].map(([id, e]) => ({ id, path: e.path, name: e.name }));
        return { status: 200, body: { repos: entries } };
      }
      if (route === '/open' && method === 'POST') {
        let raw = '';
        try {
          const parsed = JSON.parse(rawBody) as { path?: string };
          raw = typeof parsed.path === 'string' ? parsed.path : '';
        } catch {
          raw = '';
        }
        const abs = await resolveOpenRepo(raw);
        if (!abs) return { status: 400, body: { error: 'Not a git repository' } };
        const entry = register(abs);
        return { status: 200, body: { ok: true, id: entry.id, path: entry.path, name: entry.name } };
      }
      // Settings and their connectivity probes are global, not repo-scoped.
      if (route === '/settings' && method === 'GET') {
        return { status: 200, body: publicSettings() };
      }
      if (route === '/settings' && method === 'POST') {
        const patch = rawBody ? (JSON.parse(rawBody) as unknown) : {};
        return { status: 200, body: saveSettings(patch) };
      }
      if (route === '/settings/test-ai' && method === 'POST') {
        const { providerId } = JSON.parse(rawBody || '{}') as { providerId?: string };
        const provider =
          (providerId !== undefined ? providerById(providerId) : null) ?? activeProvider();
        if (!provider) return { status: 400, body: { error: 'No AI provider configured' } };
        const reply = await testProvider(provider);
        return { status: 200, body: { ok: true, reply } };
      }
      if (route === '/settings/test-forge' && method === 'POST') {
        const { forge } = JSON.parse(rawBody || '{}') as { forge?: string };
        const kind = forge === 'github' ? 'github' : 'gitlab';
        const username = await testForge(kind);
        return { status: 200, body: { ok: true, username } };
      }
      if (route === '/settings/test-gitlab' && method === 'POST') {
        const username = await testGitLab();
        return { status: 200, body: { ok: true, username } };
      }
      // Every repo-scoped route must name a registered repository.
      const entry = repoId !== undefined ? repos.get(repoId) : undefined;
      if (!entry) return { status: 400, body: { error: 'Unknown repository' } };
      const repoPath = entry.path;
      // Forge-neutral request routes; `/gitlab/*` are deprecated aliases that force
      // the GitLab forge so old clients keep working.
      if (
        (route.startsWith('/forge/') || route.startsWith('/gitlab/')) &&
        (route.endsWith('/mrs') || route.endsWith('/mr') || route.endsWith('/approve'))
      ) {
        const suffix = route.slice(route.lastIndexOf('/'));
        const forge = route.startsWith('/gitlab/')
          ? forgeByKind('gitlab')
          : await resolveForge(repoPath);
        if (suffix === '/mrs' && method === 'GET') {
          const mrs = await forge.listRequests(repoPath);
          return { status: 200, body: { ok: true, mrs } };
        }
        if (suffix === '/mr' && method === 'POST') {
          const { iid, fetch: doFetch } = JSON.parse(rawBody) as { iid?: number; fetch?: boolean };
          if (!Number.isInteger(iid) || (iid ?? 0) < 1) {
            return { status: 400, body: { error: 'Missing request number' } };
          }
          const changes = await forge.getChanges(repoPath, iid as number);
          // A failed fetch is reported alongside the changes rather than failing the
          // request: the in-memory diff is still reviewable without the objects.
          let fetchResult: { fetched: boolean; error?: string } | undefined;
          if (doFetch === true) {
            try {
              fetchResult = await forge.ensureRefs(repoPath, changes);
            } catch (err) {
              fetchResult = { fetched: false, error: err instanceof Error ? err.message : String(err) };
            }
          }
          return { status: 200, body: { ok: true, changes, fetch: fetchResult } };
        }
        if (suffix === '/approve' && method === 'POST') {
          const { iid } = JSON.parse(rawBody) as { iid?: number };
          if (!Number.isInteger(iid) || (iid ?? 0) < 1) {
            return { status: 400, body: { error: 'Missing request number' } };
          }
          await forge.approve(repoPath, iid as number);
          return { status: 200, body: { ok: true } };
        }
      }
      if (route === '/review/generate' && method === 'POST') {
        const parsed = JSON.parse(rawBody) as {
          iid?: number;
          providerId?: string;
          rule?: Partial<ReviewRuleConfig>;
          maxSteps?: number;
        };
        if (!Number.isInteger(parsed.iid) || (parsed.iid ?? 0) < 1) {
          return { status: 400, body: { error: 'Missing request number' } };
        }
        const forge = await resolveForge(repoPath);
        const changes = await forge.getChanges(repoPath, parsed.iid as number);
        await forge.ensureRefs(repoPath, changes).catch(() => {
          // Best effort: without the objects the agent's repo tools degrade, but the
          // diff-based review still runs.
        });
        const job = startReview({
          repoPath,
          changes,
          providerId: parsed.providerId,
          rule: parsed.rule,
          maxSteps: parsed.maxSteps,
        });
        return { status: 200, body: { ok: true, job } };
      }
      if (route === '/review/status' && method === 'POST') {
        const { jobId } = JSON.parse(rawBody) as { jobId?: string };
        if (!jobId?.trim()) return { status: 400, body: { error: 'Missing jobId' } };
        const id = jobId.trim();
        // A job may only be seen through the repository it belongs to.
        if (reviewJobRepo(id) !== repoPath) {
          return { status: 404, body: { error: 'Unknown review job' } };
        }
        const job = getReviewJob(id);
        if (!job) return { status: 404, body: { error: 'Unknown review job' } };
        return { status: 200, body: { ok: true, job } };
      }
      if (route === '/review/cancel' && method === 'POST') {
        const { jobId } = JSON.parse(rawBody) as { jobId?: string };
        if (!jobId?.trim()) return { status: 400, body: { error: 'Missing jobId' } };
        const id = jobId.trim();
        if (reviewJobRepo(id) !== repoPath) {
          return { status: 404, body: { error: 'Unknown review job' } };
        }
        const cancelled = cancelReviewJob(id);
        return { status: 200, body: { ok: true, cancelled } };
      }
      if (route === '/review/pause' && method === 'POST') {
        const { jobId } = JSON.parse(rawBody) as { jobId?: string };
        if (!jobId?.trim()) return { status: 400, body: { error: 'Missing jobId' } };
        const id = jobId.trim();
        if (reviewJobRepo(id) !== repoPath) {
          return { status: 404, body: { error: 'Unknown review job' } };
        }
        const paused = pauseReviewJob(id);
        return { status: 200, body: { ok: true, paused } };
      }
      if (route === '/review/resume' && method === 'POST') {
        const { jobId } = JSON.parse(rawBody) as { jobId?: string };
        if (!jobId?.trim()) return { status: 400, body: { error: 'Missing jobId' } };
        const job = resumeReview(repoPath, jobId.trim());
        if (!job) return { status: 404, body: { error: 'No paused review to resume' } };
        return { status: 200, body: { ok: true, job } };
      }
      if (route === '/review/sessions' && method === 'GET') {
        return { status: 200, body: { ok: true, sessions: listReviewSessions(repoPath) } };
      }
      if (route === '/review/session' && method === 'POST') {
        const { sessionId } = JSON.parse(rawBody) as { sessionId?: string };
        if (!sessionId?.trim()) return { status: 400, body: { error: 'Missing sessionId' } };
        const view = loadReviewSession(repoPath, sessionId.trim());
        if (!view) return { status: 404, body: { error: 'Unknown review session' } };
        return { status: 200, body: { ok: true, ...view } };
      }
      if (route === '/review/session/save' && method === 'POST') {
        const { sessionId, comments } = JSON.parse(rawBody) as {
          sessionId?: string;
          comments?: ReviewComment[];
        };
        if (!sessionId?.trim()) return { status: 400, body: { error: 'Missing sessionId' } };
        if (!Array.isArray(comments)) {
          return { status: 400, body: { error: 'comments must be an array' } };
        }
        const saved = saveReviewSessionComments(repoPath, sessionId.trim(), comments);
        return { status: 200, body: { ok: true, saved } };
      }
      if (route === '/review/session/delete' && method === 'POST') {
        const { sessionId } = JSON.parse(rawBody) as { sessionId?: string };
        if (!sessionId?.trim()) return { status: 400, body: { error: 'Missing sessionId' } };
        const deleted = deleteReviewSession(repoPath, sessionId.trim());
        return { status: 200, body: { ok: true, deleted } };
      }
      if (route === '/review/post' && method === 'POST') {
        const { iid, comments, diffRefs, forge: forgeKind } = JSON.parse(rawBody) as {
          iid?: number;
          comments?: ReviewComment[];
          diffRefs?: { baseSha?: string; headSha?: string; startSha?: string };
          forge?: string;
        };
        if (!Number.isInteger(iid) || (iid ?? 0) < 1) {
          return { status: 400, body: { error: 'Missing request number' } };
        }
        if (!Array.isArray(comments)) return { status: 400, body: { error: 'comments must be an array' } };
        const refs = {
          baseSha: diffRefs?.baseSha ?? '',
          headSha: diffRefs?.headSha ?? '',
          startSha: diffRefs?.startSha ?? '',
        };
        const kind = forgeKind === 'github' ? 'github' : forgeKind === 'gitlab' ? 'gitlab' : undefined;
        const results: Array<{ id: string; ok: boolean; discussionId?: string; error?: string }> = [];
        for (const comment of comments) {
          if (comment.status !== 'approved') continue;
          try {
            const discussionId = await createDiscussion(repoPath, iid as number, comment, refs, kind);
            results.push({ id: comment.id, ok: true, discussionId });
          } catch (err) {
            results.push({
              id: comment.id,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        return { status: 200, body: { ok: true, results } };
      }
      if (route === '/state' && method === 'GET') {
        const [{ stashes, hidden }, { state, fingerprint: refsPrint }, status, conflicts, submodules] =
          await Promise.all([
            loadStashes(repoPath),
            loadRepoRefs(repoPath),
            loadStatus(repoPath).catch(() => ({ entries: [] as StatusEntry[] })),
            loadConflicts(repoPath).catch(() => [] as ConflictEntry[]),
            loadSubmodules(repoPath).catch(() => [] as SubmoduleInfo[]),
          ]);
        let operation: MergeOperation = { kind: 'none', inProgress: false, onto: null, conflictCount: 0, oursLabel: null, theirsLabel: null };
        try {
          operation = await loadMergeState(repoPath, conflicts);
        } catch {
          // Leave the neutral operation when git metadata can't be read.
        }
        const fingerprint = `${refsPrint}\nstash:${[...stashes.keys()].sort().join(',')}`;
        const cacheKey = repoId ?? repoPath;
        const cached = logCache.get(cacheKey);
        let commits: GitCommit[];
        if (cached && cached.fingerprint === fingerprint) {
          commits = cached.commits;
        } else {
          commits = (await loadLog(repoPath, 500, stashes)).filter((c) => !hidden.has(c.hash));
          logCache.set(cacheKey, { fingerprint, commits });
        }
        return {
          status: 200,
          body: { configured: true, repoPath, state, commits, status, conflicts, operation, submodules },
        };
      }
      if (route === '/activity' && method === 'GET') {
        return { status: 200, body: repoActivity(repoPath) };
      }

      if (route === '/conflicts' && method === 'GET') {
        const conflicts = await loadConflicts(repoPath);
        const operation = await loadMergeState(repoPath, conflicts);
        return { status: 200, body: { ok: true, conflicts, operation } };
      }
      if (route === '/conflict-file' && method === 'POST') {
        const { path: filePath } = JSON.parse(rawBody) as { path?: string };
        if (!filePath?.trim()) return { status: 400, body: { error: 'Missing path' } };
        const file = await loadConflictFile(repoPath, filePath.trim());
        return { status: 200, body: { ok: true, file } };
      }
      if (route === '/conflict-save' && method === 'POST') {
        const { path: filePath, content } = JSON.parse(rawBody) as {
          path?: string;
          content?: string;
        };
        if (!filePath?.trim()) return { status: 400, body: { error: 'Missing path' } };
        if (typeof content !== 'string') return { status: 400, body: { error: 'Missing content' } };
        await writeWorkingFile(repoPath, filePath.trim(), content);
        await gitRun(repoPath, ['add', '--', filePath.trim()]);
        return { status: 200, body: { ok: true } };
      }
      if (route === '/conflict-resolve' && method === 'POST') {
        const { path: filePath, resolution } = JSON.parse(rawBody) as {
          path?: string;
          resolution?: 'ours' | 'theirs' | 'resolved';
        };
        if (!filePath?.trim()) return { status: 400, body: { error: 'Missing path' } };
        if (resolution !== 'ours' && resolution !== 'theirs' && resolution !== 'resolved') {
          return { status: 400, body: { error: 'Invalid resolution' } };
        }
        await resolveConflict(repoPath, filePath.trim(), resolution);
        return { status: 200, body: { ok: true } };
      }
      if (route === '/conflict-continue' && method === 'POST') {
        const out = await continueOperation(repoPath);
        return { status: 200, body: { ok: true, output: out } };
      }
      if (route === '/conflict-abort' && method === 'POST') {
        const out = await abortOperation(repoPath);
        return { status: 200, body: { ok: true, output: out } };
      }
      if (route === '/conflict-skip' && method === 'POST') {
        const out = await skipOperation(repoPath);
        return { status: 200, body: { ok: true, output: out } };
      }
      if (route === '/conflict-fix' && method === 'POST') {
        const { path: filePath, providerId } = JSON.parse(rawBody || '{}') as {
          path?: string;
          providerId?: string;
        };
        if (!filePath?.trim()) return { status: 400, body: { error: 'Missing path' } };
        const file = await loadConflictFile(repoPath, filePath.trim());
        const fix = await proposeConflictFix(file, providerId);
        return { status: 200, body: { ok: true, fix } };
      }
      if (route === '/conflict-apply' && method === 'POST') {
        const { path: filePath, kind, content } = JSON.parse(rawBody || '{}') as {
          path?: string;
          kind?: 'content' | 'delete';
          content?: string | null;
        };
        if (!filePath?.trim()) return { status: 400, body: { error: 'Missing path' } };
        if (kind !== 'content' && kind !== 'delete') {
          return { status: 400, body: { error: 'Invalid kind' } };
        }
        await applyConflictFix(repoPath, filePath.trim(), kind, content ?? null);
        return { status: 200, body: { ok: true } };
      }
      if (route === '/submodules' && method === 'GET') {
        const submodules = await loadSubmodules(repoPath);
        return { status: 200, body: { ok: true, submodules } };
      }
      if (route === '/submodule-update' && method === 'POST') {
        const { remote, init } = JSON.parse(rawBody) as { remote?: boolean; init?: boolean };
        const out = await submoduleUpdate(repoPath, { remote, init });
        return { status: 200, body: { ok: true, output: out } };
      }
      if (route === '/submodule-sync' && method === 'POST') {
        const out = await submoduleSync(repoPath);
        return { status: 200, body: { ok: true, output: out } };
      }
      if (route === '/submodule-add' && method === 'POST') {
        const { url, path: dest, branch } = JSON.parse(rawBody) as {
          url?: string;
          path?: string;
          branch?: string;
        };
        if (!url?.trim()) return { status: 400, body: { error: 'Missing URL' } };
        const out = await submoduleAdd(repoPath, url.trim(), dest?.trim(), branch?.trim());
        return { status: 200, body: { ok: true, output: out } };
      }
      if (route === '/submodule-deinit' && method === 'POST') {
        const { path: dest, force } = JSON.parse(rawBody) as { path?: string; force?: boolean };
        if (!dest?.trim()) return { status: 400, body: { error: 'Missing path' } };
        const out = await submoduleDeinit(repoPath, dest.trim(), force === true);
        return { status: 200, body: { ok: true, output: out } };
      }
      if (route === '/submodule-log' && method === 'POST') {
        const { path: subPath } = JSON.parse(rawBody) as { path?: string };
        if (!subPath?.trim()) return { status: 400, body: { error: 'Missing path' } };
        const commits = await loadSubmoduleLog(repoPath, subPath.trim());
        return { status: 200, body: { ok: true, commits } };
      }

      if (route === '/commit' && method === 'POST') {
        const { message, files } = JSON.parse(rawBody) as {
          message?: string;
          files?: unknown;
        };
        if (!message?.trim()) return { status: 400, body: { error: 'Empty commit message' } };
        if (!Array.isArray(files)) return { status: 400, body: { error: 'files must be an array' } };
        const wanted = files.filter((f): f is string => typeof f === 'string');
        if (wanted.length === 0) return { status: 400, body: { error: 'No files selected' } };
        const hash = await createCommit(repoPath, message.trim(), wanted);
        return { status: 200, body: { ok: true, hash } };
      }
      if (route === '/commit-message' && method === 'POST') {
        const { files, providerId } = JSON.parse(rawBody) as {
          files?: unknown;
          providerId?: string;
        };
        if (!Array.isArray(files)) return { status: 400, body: { error: 'files must be an array' } };
        const wanted = files.filter((f): f is string => typeof f === 'string');
        if (wanted.length === 0) return { status: 400, body: { error: 'No files selected' } };
        const rule = commitRule();
        const diff = await selectedWorktreeDiffs(repoPath, wanted, rule.maxDiffChars);
        let history: string[] = [];
        if (rule.includeHistory) {
          try {
            const out = await gitRun(repoPath, [
              'log',
              '-n',
              '20',
              '--format=%s',
            ]);
            history = out.split('\n').filter((s) => s.trim().length > 0);
          } catch {
            // A repo without commits (unborn HEAD) simply has no history.
          }
        }
        const message = await generateCommitMessage(
          rule,
          { diff, history },
          typeof providerId === 'string' && providerId ? providerId : undefined,
        );
        return { status: 200, body: { ok: true, message } };
      }
      if (route === '/rebase' && method === 'POST') {
        const { onto } = JSON.parse(rawBody) as { onto?: string };
        if (!onto?.trim()) return { status: 400, body: { error: 'Missing branch' } };
        const dirty = await dirtyGuard(repoPath, 'rebasing');
        if (dirty) return { status: 409, body: { error: dirty } };
        const out = await rebaseOnto(repoPath, onto.trim());
        return { status: 200, body: { ok: true, output: out } };
      }
      if (route === '/rebase-start' && method === 'POST') {
        if (!INTERACTIVE_REBASE_ENABLED) {
          return { status: 404, body: { error: 'Interactive rebase disabled' } };
        }
        const { onto } = JSON.parse(rawBody) as { onto?: string };
        if (!onto?.trim()) return { status: 400, body: { error: 'Missing branch' } };
        const dirty = await dirtyGuard(repoPath, 'rebasing');
        if (dirty) return { status: 409, body: { error: dirty } };
        const plan = await loadRebasePlan(repoPath, onto.trim());
        return { status: 200, body: { ok: true, onto: plan.onto, items: plan.items } };
      }
      if (route === '/rebase-execute' && method === 'POST') {
        if (!INTERACTIVE_REBASE_ENABLED) {
          return { status: 404, body: { error: 'Interactive rebase disabled' } };
        }
        const { onto, items } = JSON.parse(rawBody) as {
          onto?: string;
          items?: RebaseTodoItem[];
        };
        if (!onto?.trim()) return { status: 400, body: { error: 'Missing branch' } };
        if (!Array.isArray(items) || items.length === 0) {
          return { status: 400, body: { error: 'Empty rebase todo' } };
        }
        const dirty = await dirtyGuard(repoPath, 'rebasing');
        if (dirty) return { status: 409, body: { error: dirty } };
        const out = await executeRebase(repoPath, onto.trim(), items);
        return { status: 200, body: { ok: true, output: out } };
      }
      if (route === '/merge' && method === 'POST') {
        const { ref } = JSON.parse(rawBody) as { ref?: string };
        if (!ref?.trim()) return { status: 400, body: { error: 'Missing ref' } };
        const dirty = await dirtyGuard(repoPath, 'merging');
        if (dirty) return { status: 409, body: { error: dirty } };
        const out = await mergeBranch(repoPath, ref.trim());
        return { status: 200, body: { ok: true, output: out } };
      }
      if (route === '/cherry-pick' && method === 'POST') {
        const { ref, mainline, record } = JSON.parse(rawBody) as {
          ref?: string;
          mainline?: number;
          record?: boolean;
        };
        if (!ref?.trim()) return { status: 400, body: { error: 'Missing ref' } };
        if (mainline !== undefined && (!Number.isInteger(mainline) || mainline < 1)) {
          return { status: 400, body: { error: 'mainline must be a positive integer' } };
        }
        const dirty = await dirtyGuard(repoPath, 'cherry-picking');
        if (dirty) return { status: 409, body: { error: dirty } };
        const out = await cherryPick(repoPath, ref.trim(), { mainline, record });
        return { status: 200, body: { ok: true, output: out } };
      }
      if (route === '/revert' && method === 'POST') {
        const { ref, mainline } = JSON.parse(rawBody) as { ref?: string; mainline?: number };
        if (!ref?.trim()) return { status: 400, body: { error: 'Missing ref' } };
        if (mainline !== undefined && (!Number.isInteger(mainline) || mainline < 1)) {
          return { status: 400, body: { error: 'mainline must be a positive integer' } };
        }
        const dirty = await dirtyGuard(repoPath, 'reverting');
        if (dirty) return { status: 409, body: { error: dirty } };
        const out = await revert(repoPath, ref.trim(), { mainline });
        return { status: 200, body: { ok: true, output: out } };
      }
      if (route === '/commit-diff' && method === 'POST') {
        const { hash } = JSON.parse(rawBody) as { hash?: string };
        if (!hash?.trim()) return { status: 400, body: { error: 'Missing hash' } };
        const files = await commitFiles(repoPath, hash.trim());
        return { status: 200, body: { ok: true, files } };
      }
      if (route === '/commit-file-diff' && method === 'POST') {
        const { hash, path: filePath, oldPath } = JSON.parse(rawBody) as {
          hash?: string;
          path?: string;
          oldPath?: string | null;
        };
        if (!hash?.trim()) return { status: 400, body: { error: 'Missing hash' } };
        if (!filePath?.trim()) return { status: 400, body: { error: 'Missing path' } };
        const patch = await commitPatch(
          repoPath,
          hash.trim(),
          filePath.trim(),
          typeof oldPath === 'string' && oldPath ? oldPath : null,
        );
        return { status: 200, body: { ok: true, patch } };
      }
      if (route === '/worktree-file-diff' && method === 'POST') {
        const { path: filePath, oldPath } = JSON.parse(rawBody) as {
          path?: string;
          oldPath?: string | null;
        };
        if (!filePath?.trim()) return { status: 400, body: { error: 'Missing path' } };
        const patch = await worktreePatch(
          repoPath,
          filePath.trim(),
          typeof oldPath === 'string' && oldPath ? oldPath : null,
        );
        return { status: 200, body: { ok: true, patch } };
      }
      if (route === '/file-content' && method === 'POST') {
        const { hash, path: filePath, oldPath } = JSON.parse(rawBody) as {
          hash?: string | null;
          path?: string;
          oldPath?: string | null;
        };
        if (!filePath?.trim()) return { status: 400, body: { error: 'Missing path' } };
        const contents = await fileContents(
          repoPath,
          typeof hash === 'string' && hash ? hash : null,
          filePath.trim(),
          typeof oldPath === 'string' && oldPath ? oldPath : null,
        );
        return { status: 200, body: { ok: true, ...contents } };
      }
      if (route === '/checkout' && method === 'POST') {
        const { branch, remote } = JSON.parse(rawBody) as { branch?: string; remote?: boolean };
        if (!branch?.trim()) return { status: 400, body: { error: 'Missing branch' } };
        await checkoutBranch(repoPath, branch.trim(), remote === true);
        return { status: 200, body: { ok: true } };
      }
      if (route === '/branch-create' && method === 'POST') {
        const { name, ref } = JSON.parse(rawBody) as { name?: string; ref?: string };
        const branch = name?.trim() ?? '';
        if (!validRefName(branch)) return { status: 400, body: { error: 'Invalid branch name' } };
        if (!ref?.trim()) return { status: 400, body: { error: 'Missing start point' } };
        await createBranch(repoPath, branch, ref.trim());
        return { status: 200, body: { ok: true } };
      }
      if (route === '/branch-delete' && method === 'POST') {
        const { name, remote } = JSON.parse(rawBody) as { name?: string; remote?: boolean };
        const branch = name?.trim() ?? '';
        if (!branch) return { status: 400, body: { error: 'Missing branch' } };
        if (remote) await deleteRemoteBranchPush(repoPath, branch);
        else await deleteBranch(repoPath, branch);
        return { status: 200, body: { ok: true } };
      }
      if (route === '/tag-create' && method === 'POST') {
        const { name, ref } = JSON.parse(rawBody) as { name?: string; ref?: string };
        const tag = name?.trim() ?? '';
        if (!validRefName(tag)) return { status: 400, body: { error: 'Invalid tag name' } };
        if (!ref?.trim()) return { status: 400, body: { error: 'Missing start point' } };
        await createTag(repoPath, tag, ref.trim());
        return { status: 200, body: { ok: true } };
      }
      if (route === '/tag-delete' && method === 'POST') {
        const { name } = JSON.parse(rawBody) as { name?: string };
        if (!name?.trim()) return { status: 400, body: { error: 'Missing tag' } };
        await deleteTag(repoPath, name.trim());
        return { status: 200, body: { ok: true } };
      }
      if (route === '/reset' && method === 'POST') {
        const { mode, ref } = JSON.parse(rawBody) as { mode?: ResetMode; ref?: string };
        if (!mode || !RESET_MODES.includes(mode)) {
          return { status: 400, body: { error: 'Invalid reset mode' } };
        }
        if (!ref?.trim()) return { status: 400, body: { error: 'Missing ref' } };
        await resetBranch(repoPath, mode, ref.trim());
        return { status: 200, body: { ok: true } };
      }
      if (route === '/stash' && method === 'POST') {
        const { message, includeUntracked } = JSON.parse(rawBody) as {
          message?: string;
          includeUntracked?: boolean;
        };
        const hash = await createStash(repoPath, message ?? '', includeUntracked === true);
        if (!hash) return { status: 200, body: { ok: true, stashed: false } };
        return { status: 200, body: { ok: true, stashed: true, hash } };
      }
      if (route === '/stash-apply' && method === 'POST') {
        const { hash } = JSON.parse(rawBody) as { hash?: string };
        if (!hash?.trim()) return { status: 400, body: { error: 'Missing stash' } };
        const selector = await resolveStash(repoPath, hash.trim());
        const out = await applyStash(repoPath, selector);
        return { status: 200, body: { ok: true, output: out } };
      }
      if (route === '/stash-drop' && method === 'POST') {
        const { hash } = JSON.parse(rawBody) as { hash?: string };
        if (!hash?.trim()) return { status: 400, body: { error: 'Missing stash' } };
        const selector = await resolveStash(repoPath, hash.trim());
        const out = await dropStash(repoPath, selector);
        return { status: 200, body: { ok: true, output: out } };
      }
      if (route === '/remote-status' && method === 'GET') {
        const status = await loadRemoteStatus(repoPath);
        return { status: 200, body: status };
      }
      if (route === '/push' && method === 'POST') {
        const { remote, branch, force } = JSON.parse(rawBody) as {
          remote?: string;
          branch?: string;
          force?: boolean;
        };
        const out = await pushBranch(repoPath, remote, branch, force === true);
        return { status: 200, body: { ok: true, output: out } };
      }
      if (route === '/pull' && method === 'POST') {
        const { remote, branch } = JSON.parse(rawBody) as { remote?: string; branch?: string };
        const out = await pullBranch(repoPath, remote, branch);
        return { status: 200, body: { ok: true, output: out } };
      }
      if (route === '/remote-test' && method === 'POST') {
        const { remote } = JSON.parse(rawBody) as { remote?: string };
        await testRemote(repoPath, remote ?? '');
        return { status: 200, body: { ok: true } };
      }
      return { status: 404, body: { error: 'Unknown route' } };
    } catch (err) {
      if (err instanceof GitError) {
        return { status: err.status, body: { error: err.stderr || err.message } };
      }
      return { status: 500, body: { error: String(err) } };
    }
  }

  return {
    handle,
  };
}

export { GitError } from './exec';
export { repoActivity } from './exec';
export { writeWorkingFile } from './conflicts';
