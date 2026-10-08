// Settings persistence for AI providers, review rules, and GitLab.
// Node-only: imported exclusively by src/api.ts (never by the browser bundle).
//
// Secrets (AI API keys, the GitLab token) live here and only here. The file is
// written atomically with mode 0600. `LIANA_AI_API_KEY` / `LIANA_GITLAB_TOKEN`
// override the stored values at run time. `publicSettings()` masks every secret
// to a boolean `hasKey` / `hasToken` before the renderer ever sees it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AppSettings,
  CommitMessageConfig,
  ForgeKind,
  ReviewRuleConfig,
  ReviewSeverity,
} from './types';

/** One provider as stored on disk (includes the secret key). */
export interface StoredProvider {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  contextWindow: number;
  maxTokens: number;
  temperature: number;
  toolResultChars: number;
  maxSteps: number;
}

interface StoredSettings {
  ai: {
    providers: StoredProvider[];
    activeProviderId: string | null;
  };
  review: ReviewRuleConfig;
  commit: CommitMessageConfig;
  gitlab: {
    baseUrl: string;
    token: string;
    projectId: string;
  };
  github: {
    baseUrl: string;
    token: string;
    repo: string;
  };
  forge: ForgeKind | 'auto';
}

const SEVERITIES: ReviewSeverity[] = ['info', 'warning', 'error'];
const FORGES: Array<ForgeKind | 'auto'> = ['auto', 'gitlab', 'github'];

/** Location of the config file (`XDG_CONFIG_HOME` aware). */
export function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config');
  return path.join(base, 'liana', 'config.json');
}

function defaultRule(): ReviewRuleConfig {
  return {
    instructions:
      'You are a careful senior reviewer. Focus on correctness, security, and ' +
      'maintainability. Point to concrete lines and explain the risk. Avoid ' +
      'style nitpicks unless they hide a bug.',
    severityThreshold: 'info',
    ignoreGlobs: ['**/dist/**', '**/node_modules/**', '**/*.lock', '**/*.min.js'],
    maxComments: 0,
    language: 'English',
    maxSteps: 8,
    batchByFile: true,
  };
}

function defaultCommitRule(): CommitMessageConfig {
  return {
    instructions:
      'Write a clear, conventional commit message for the staged changes. Use the ' +
      'imperative mood in the subject line, keep it under 72 characters, and add a ' +
      'short body only when the change needs explaining. Describe what changed and why.',
    language: 'English',
    includeHistory: true,
    maxDiffChars: 12000,
  };
}

function defaultProvider(): StoredProvider {
  return {
    id: '',
    name: 'Local model',
    baseUrl: 'http://localhost:11434/v1',
    model: '',
    apiKey: '',
    contextWindow: 8192,
    maxTokens: 1024,
    temperature: 0.1,
    toolResultChars: 2000,
    maxSteps: 8,
  };
}

function defaults(): StoredSettings {
  return {
    ai: { providers: [], activeProviderId: null },
    review: defaultRule(),
    commit: defaultCommitRule(),
    gitlab: { baseUrl: 'https://gitlab.com', token: '', projectId: '' },
    github: { baseUrl: 'https://api.github.com', token: '', repo: '' },
    forge: 'auto',
  };
}

// --- tolerant coercion helpers (the file may be hand-edited) ---

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function int(v: unknown, fallback: number, min = 0): number {
  const n = num(v, fallback);
  return Number.isInteger(n) && n >= min ? n : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function severity(v: unknown, fallback: ReviewSeverity): ReviewSeverity {
  return typeof v === 'string' && (SEVERITIES as string[]).includes(v)
    ? (v as ReviewSeverity)
    : fallback;
}

function globs(v: unknown, fallback: string[]): string[] {
  if (!Array.isArray(v)) return fallback;
  return v.filter((x): x is string => typeof x === 'string');
}

function parseProviders(v: unknown): StoredProvider[] {
  if (!Array.isArray(v)) return [];
  const out: StoredProvider[] = [];
  for (const raw of v) {
    if (typeof raw !== 'object' || raw === null) continue;
    const p = raw as Record<string, unknown>;
    const base = defaultProvider();
    const id = str(p.id, '');
    if (!id) continue;
    out.push({
      id,
      name: str(p.name, base.name),
      baseUrl: str(p.baseUrl, base.baseUrl),
      model: str(p.model, base.model),
      apiKey: str(p.apiKey, ''),
      contextWindow: int(p.contextWindow, base.contextWindow, 512),
      maxTokens: int(p.maxTokens, base.maxTokens, 1),
      temperature: num(p.temperature, base.temperature),
      toolResultChars: int(p.toolResultChars, base.toolResultChars, 200),
      maxSteps: int(p.maxSteps, base.maxSteps, 1),
    });
  }
  return out;
}

function parseRule(v: unknown): ReviewRuleConfig {
  const base = defaultRule();
  if (typeof v !== 'object' || v === null) return base;
  const r = v as Record<string, unknown>;
  return {
    instructions: str(r.instructions, base.instructions),
    severityThreshold: severity(r.severityThreshold, base.severityThreshold),
    ignoreGlobs: globs(r.ignoreGlobs, base.ignoreGlobs),
    maxComments: int(r.maxComments, base.maxComments, 0),
    language: str(r.language, base.language),
    maxSteps: int(r.maxSteps, base.maxSteps, 1),
    batchByFile: bool(r.batchByFile, base.batchByFile),
  };
}

function parseCommitRule(v: unknown): CommitMessageConfig {
  const base = defaultCommitRule();
  if (typeof v !== 'object' || v === null) return base;
  const c = v as Record<string, unknown>;
  return {
    instructions: str(c.instructions, base.instructions),
    language: str(c.language, base.language),
    includeHistory: bool(c.includeHistory, base.includeHistory),
    maxDiffChars: int(c.maxDiffChars, base.maxDiffChars, 1000),
  };
}

function parseGitlab(v: unknown): StoredSettings['gitlab'] {
  const base = defaults().gitlab;
  if (typeof v !== 'object' || v === null) return base;
  const g = v as Record<string, unknown>;
  return {
    baseUrl: str(g.baseUrl, base.baseUrl).replace(/\/+$/, ''),
    token: str(g.token, ''),
    projectId: str(g.projectId, ''),
  };
}

function parseGithub(v: unknown): StoredSettings['github'] {
  const base = defaults().github;
  if (typeof v !== 'object' || v === null) return base;
  const g = v as Record<string, unknown>;
  return {
    baseUrl: str(g.baseUrl, base.baseUrl).replace(/\/+$/, ''),
    token: str(g.token, ''),
    repo: str(g.repo, ''),
  };
}

function parseForge(v: unknown): ForgeKind | 'auto' {
  return typeof v === 'string' && (FORGES as string[]).includes(v)
    ? (v as ForgeKind | 'auto')
    : 'auto';
}

function parse(raw: unknown): StoredSettings {
  const base = defaults();
  if (typeof raw !== 'object' || raw === null) return base;
  const root = raw as Record<string, unknown>;
  const ai = (typeof root.ai === 'object' && root.ai !== null ? root.ai : {}) as Record<
    string,
    unknown
  >;
  const providers = parseProviders(ai.providers);
  let activeProviderId = str(ai.activeProviderId, '') || null;
  if (activeProviderId && !providers.some((p) => p.id === activeProviderId)) activeProviderId = null;
  if (!activeProviderId && providers[0]) activeProviderId = providers[0].id;
  return {
    ai: { providers, activeProviderId },
    review: parseRule(root.review),
    commit: parseCommitRule(root.commit),
    gitlab: parseGitlab(root.gitlab),
    github: parseGithub(root.github),
    forge: parseForge(root.forge),
  };
}

/** Read the stored settings, returning defaults when the file is absent/corrupt. */
function readStored(): StoredSettings {
  try {
    const text = fs.readFileSync(configPath(), 'utf8');
    return parse(JSON.parse(text) as unknown);
  } catch {
    return defaults();
  }
}

/** The settings as exposed to the renderer, with all secrets masked. */
export function publicSettings(): AppSettings {
  const s = readStored();
  return {
    ai: {
      providers: s.ai.providers.map((p) => ({
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl,
        model: p.model,
        hasKey: p.apiKey.length > 0 || Boolean(process.env.LIANA_AI_API_KEY),
        contextWindow: p.contextWindow,
        maxTokens: p.maxTokens,
        temperature: p.temperature,
        toolResultChars: p.toolResultChars,
        maxSteps: p.maxSteps,
      })),
      activeProviderId: s.ai.activeProviderId,
    },
    review: s.review,
    commit: s.commit,
    gitlab: {
      baseUrl: s.gitlab.baseUrl,
      hasToken: s.gitlab.token.length > 0 || Boolean(process.env.LIANA_GITLAB_TOKEN),
      projectId: s.gitlab.projectId,
    },
    github: {
      baseUrl: s.github.baseUrl,
      hasToken: s.github.token.length > 0 || Boolean(process.env.LIANA_GITHUB_TOKEN),
      repo: s.github.repo,
    },
    forge: s.forge,
  };
}

function newId(existing: StoredProvider[]): string {
  let i = existing.length + 1;
  while (existing.some((p) => p.id === `p${i}`)) i++;
  return `p${i}`;
}

/**
 * Merge a partial settings patch and persist it. Secret fields are preserved
 * unless a non-empty string is supplied, so the renderer (which only ever holds
 * `hasKey`) can save other fields without clobbering the stored secret. Passing
 * an explicit empty string clears the secret.
 */
export function saveSettings(input: unknown): AppSettings {
  const current = readStored();
  const patch = (typeof input === 'object' && input !== null ? input : {}) as Record<
    string,
    unknown
  >;

  const aiPatch = (typeof patch.ai === 'object' && patch.ai !== null ? patch.ai : {}) as Record<
    string,
    unknown
  >;
  if (Array.isArray(aiPatch.providers)) {
    const existingById = new Map(current.ai.providers.map((p) => [p.id, p]));
    const next: StoredProvider[] = [];
    for (const raw of aiPatch.providers) {
      if (typeof raw !== 'object' || raw === null) continue;
      const p = raw as Record<string, unknown>;
      const base = defaultProvider();
      const id = str(p.id, '') || newId(next);
      const prev = existingById.get(id);
      const incomingKey = p.apiKey;
      const apiKey =
        typeof incomingKey === 'string' ? incomingKey : (prev?.apiKey ?? '');
      next.push({
        id,
        name: str(p.name, prev?.name ?? base.name),
        baseUrl: str(p.baseUrl, prev?.baseUrl ?? base.baseUrl).replace(/\/+$/, ''),
        model: str(p.model, prev?.model ?? base.model),
        apiKey,
        contextWindow: int(p.contextWindow, prev?.contextWindow ?? base.contextWindow, 512),
        maxTokens: int(p.maxTokens, prev?.maxTokens ?? base.maxTokens, 1),
        temperature: num(p.temperature, prev?.temperature ?? base.temperature),
        toolResultChars: int(p.toolResultChars, prev?.toolResultChars ?? base.toolResultChars, 200),
        maxSteps: int(p.maxSteps, prev?.maxSteps ?? base.maxSteps, 1),
      });
    }
    current.ai.providers = next;
  }
  if ('activeProviderId' in aiPatch) {
    const wanted = str(aiPatch.activeProviderId, '');
    current.ai.activeProviderId =
      wanted && current.ai.providers.some((p) => p.id === wanted) ? wanted : null;
  }
  if (current.ai.activeProviderId === null && current.ai.providers[0]) {
    current.ai.activeProviderId = current.ai.providers[0].id;
  }

  if ('review' in patch) current.review = parseRule(patch.review);
  if ('commit' in patch) current.commit = parseCommitRule(patch.commit);

  const glPatch = (typeof patch.gitlab === 'object' && patch.gitlab !== null ? patch.gitlab : {}) as Record<string, unknown>;
  if (Object.keys(glPatch).length > 0) {
    current.gitlab = {
      baseUrl:
        str(glPatch.baseUrl, current.gitlab.baseUrl).replace(/\/+$/, '') ||
        current.gitlab.baseUrl,
      token: typeof glPatch.token === 'string' ? glPatch.token : current.gitlab.token,
      projectId: str(glPatch.projectId, current.gitlab.projectId),
    };
  }

  const ghPatch = (typeof patch.github === 'object' && patch.github !== null ? patch.github : {}) as Record<string, unknown>;
  if (Object.keys(ghPatch).length > 0) {
    current.github = {
      baseUrl:
        str(ghPatch.baseUrl, current.github.baseUrl).replace(/\/+$/, '') ||
        current.github.baseUrl,
      token: typeof ghPatch.token === 'string' ? ghPatch.token : current.github.token,
      repo: str(ghPatch.repo, current.github.repo),
    };
  }

  if ('forge' in patch) current.forge = parseForge(patch.forge);

  writeStored(current);
  return publicSettings();
}

/** Atomically persist the settings with mode 0600. */
function writeStored(s: StoredSettings): void {
  const file = configPath();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

// --- runtime accessors (resolve env overrides) ---

/** The provider selected for review, or null when none is configured. */
export function activeProvider(): StoredProvider | null {
  const s = readStored();
  if (!s.ai.activeProviderId) return s.ai.providers[0] ?? null;
  return s.ai.providers.find((p) => p.id === s.ai.activeProviderId) ?? s.ai.providers[0] ?? null;
}

/** API key for a provider: `LIANA_AI_API_KEY` wins over the stored value. */
export function providerKey(provider: StoredProvider): string {
  return process.env.LIANA_AI_API_KEY?.trim() || provider.apiKey;
}

/** Look up a stored provider by id, or null when it no longer exists. */
export function providerById(id: string): StoredProvider | null {
  return readStored().ai.providers.find((p) => p.id === id) ?? null;
}

/** GitLab base URL, token, and project override, with env override applied. */
export function gitlabConfig(): { baseUrl: string; token: string; projectId: string } {
  const s = readStored();
  return {
    baseUrl: s.gitlab.baseUrl.replace(/\/+$/, '') || 'https://gitlab.com',
    token: process.env.LIANA_GITLAB_TOKEN?.trim() || s.gitlab.token,
    projectId: s.gitlab.projectId,
  };
}

/** GitHub base URL, token, and repo override, with env override applied. */
export function githubConfig(): { baseUrl: string; token: string; repo: string } {
  const s = readStored();
  return {
    baseUrl: s.github.baseUrl.replace(/\/+$/, '') || 'https://api.github.com',
    token: process.env.LIANA_GITHUB_TOKEN?.trim() || s.github.token,
    repo: s.github.repo,
  };
}

/** The configured forge preference: `auto` or a forced forge. */
export function forgePreference(): ForgeKind | 'auto' {
  return readStored().forge;
}

/** The effective reviewer rule. */
export function reviewRule(): ReviewRuleConfig {
  return readStored().review;
}

/** The effective AI commit-message rule. */
export function commitRule(): CommitMessageConfig {
  return readStored().commit;
}
