// Forge registry and per-repository selection. Node-only. Kept separate from
// src/forge.ts so the forge implementations can import the interface/helpers
// from ./forge without a load-order cycle back through this module.

import { githubForge } from './github';
import { gitlabForge } from './gitlab';
import { forgePreference, githubConfig, gitlabConfig } from './settings';
import { gitRemoteOrigin, type ReviewForge } from './forge';
import type { ForgeKind } from './types';

/** The host of a URL, or null when it can't be parsed. */
function hostOf(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  const scp = trimmed.match(/^[^@]+@([^:]+):/);
  if (scp?.[1]) return scp[1].toLowerCase();
  try {
    return new URL(trimmed).host.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** Infer the forge from an origin URL: known hosts or the configured base URLs. */
export function detectForgeFromRemote(url: string): ForgeKind | null {
  const host = hostOf(url);
  if (!host) return null;
  if (host === 'github.com') return 'github';
  if (host === 'gitlab.com') return 'gitlab';
  if (host === hostOf(githubConfig().baseUrl)) return 'github';
  if (host === hostOf(gitlabConfig().baseUrl)) return 'gitlab';
  return null;
}

/**
 * Look up a forge by kind. A switch (not a top-level object) keeps the forge
 * module's initialization order unambiguous.
 */
export function forgeByKind(kind: ForgeKind): ReviewForge {
  switch (kind) {
    case 'github':
      return githubForge;
    case 'gitlab':
      return gitlabForge;
  }
}

/**
 * Resolve the forge for a repository: an explicit settings preference wins over
 * the origin host, which wins over which token is configured. Defaults to gitlab
 * so existing GitLab-only users keep working unchanged.
 */
export async function resolveForge(repoPath: string): Promise<ReviewForge> {
  const pref = forgePreference();
  if (pref === 'gitlab') return gitlabForge;
  if (pref === 'github') return githubForge;
  const origin = await gitRemoteOrigin(repoPath);
  const detected = detectForgeFromRemote(origin);
  if (detected) return forgeByKind(detected);
  const hasGithub = Boolean(githubConfig().token);
  const hasGitlab = Boolean(gitlabConfig().token);
  if (hasGithub && !hasGitlab) return githubForge;
  if (hasGitlab && !hasGithub) return gitlabForge;
  return gitlabForge;
}
