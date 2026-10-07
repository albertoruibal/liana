// fetch('/api/*') helpers, scoped to the active tab or an explicit repo id.

import type { ReviewTabState } from './store';
import { store } from './store';

// fetch('/api/*') helpers, scoped to the active tab or an explicit repo id.
export interface ApiOpts {
  /** Send the active tab's repository id. Set false for repo-management routes. */
  scoped?: boolean;
  /** Explicit repository id to scope to (used by background review polling). */
  repoId?: string;
}

export async function api<T>(route: string, body?: unknown, opts: ApiOpts = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = window.liana?.token;
  if (token) headers['x-liana-token'] = token;
  const scope = opts.repoId ?? store.activeId;
  if (opts.scoped !== false && scope) headers['x-liana-repo'] = scope;
  const res = await fetch(`/api${route}`, {
    method: body !== undefined ? 'POST' : 'GET',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

/**
 * Review/GitLab calls are scoped to the repository a review tab is bound to,
 * not the active tab, so background polling keeps working after a tab switch.
 */
export function reviewApi<T>(state: ReviewTabState, route: string, body?: unknown): Promise<T> {
  return api<T>(route, body, { repoId: state.repoId });
}
