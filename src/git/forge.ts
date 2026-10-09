// Browser-side mirror of the /api/forge/* and /api/review/* routes in
// src/api/index.ts.
//
// Node-side mirror of the forge routes: the same operations the backend exposes
// over HTTP, callable directly. Types come from src/types.ts and are identical on
// both sides. The browser UI still talks to /api (see src/ui/).

import type { AiModelInfo, ForgeKind, ReviewChanges, ReviewRequest } from '../types';
import type { StoredProvider } from '../settings';

/** Open merge/pull requests for the repository's resolved forge. */
export async function apiListRequests(repoPath: string): Promise<ReviewRequest[]> {
  const { resolveForge } = await import('../forges');
  return (await resolveForge(repoPath)).listRequests(repoPath);
}

/** One request plus its changed files and diff refs; `fetch` also fetches the head. */
export async function apiGetRequestChanges(
  repoPath: string,
  iid: number,
  fetch?: boolean,
): Promise<{ changes: ReviewChanges; fetch?: { fetched: boolean; error?: string } }> {
  const { resolveForge } = await import('../forges');
  const forge = await resolveForge(repoPath);
  const changes = await forge.getChanges(repoPath, iid);
  let fetchResult: { fetched: boolean; error?: string } | undefined;
  if (fetch) {
    try {
      fetchResult = await forge.ensureRefs(repoPath, changes);
    } catch (err) {
      fetchResult = { fetched: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  return { changes, fetch: fetchResult };
}

/** Approve a merge/pull request on the repository's resolved forge. */
export async function apiApproveRequest(repoPath: string, iid: number): Promise<void> {
  const { resolveForge } = await import('../forges');
  await (await resolveForge(repoPath)).approve(repoPath, iid);
}

/** Check out a request's source branch and pull it. */
export async function apiCheckoutRequestBranch(
  repoPath: string,
  forge: ForgeKind,
  iid: number,
  branch: string,
): Promise<string> {
  const { forgeByKind } = await import('../forges');
  return forgeByKind(forge).checkoutBranch(repoPath, iid, branch);
}

/** Authenticated probe for the Settings "Test" button against an explicit forge. */
export async function apiTestForge(forge: 'gitlab' | 'github'): Promise<string> {
  const { forgeByKind } = await import('../forges');
  return forgeByKind(forge).test();
}

/**
 * List the models on a provider's OpenAI-compatible endpoint (mirrors
 * `POST /api/settings/ai-models` in src/api/index.ts). The browser UI calls this
 * over `/api`; this wrapper keeps the typed contract in sync.
 */
export async function apiListAiModels(provider: StoredProvider): Promise<AiModelInfo[]> {
  const { listProviderModels } = await import('../review');
  return listProviderModels(provider);
}
