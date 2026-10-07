// Code-review backend: OpenAI-compatible chat client plus the bounded read-only
// agent loop that turns a merge/pull request into proposed comments. The forge
// client (GitLab/GitHub) lives behind src/forge.ts / src/forges.ts. Node-only:
// imported exclusively by src/api.ts (never the browser).
//
// All HTTP runs with AbortController timeouts and surfaces the upstream error
// body unchanged. Secrets are read from src/settings.ts and never logged.

import {
  activeProvider,
  providerById,
  providerKey,
  rememberProtocol,
  reviewRule,
  type StoredProvider,
} from './settings';
import { forgeByKind, resolveForge } from './forges';
import { forgeLabel } from './forge';
import { gitlabForge } from './gitlab';
import {
  adapterFor,
  executeTool,
  extractJsonObject,
  matchesAnyGlob,
  messagesTokens,
  summarizeResult,
  TOOLS,
  type ChatMessage,
  type ToolCall,
  type ToolContext,
} from './review-tools';
import {
  deleteSession,
  listSessions,
  readSession,
  writeSession,
  type BatchCheckpoint,
  type ReviewProtocol,
  type StoredReviewSession,
} from './sessions';
import type {
  CommitMessageConfig,
  DiffRefs,
  ReviewChanges,
  ReviewComment,
  ReviewCommentStage,
  ReviewFile,
  ReviewJob,
  ReviewRequest,
  ReviewRuleConfig,
  ReviewSession,
  ReviewSessionView,
  ReviewSeverity,
  ReviewTraceStep,
  ToolProtocol,
} from './types';

// The LLM call (including a streamed response) may take a long time on slow
// local models, so allow up to 12 hours. Forge requests stay short.
const HTTP_TIMEOUT_MS = 12 * 60 * 60 * 1000;

/** Human-readable duration for timeout error messages. */
function formatTimeout(ms: number): string {
  const hours = ms / 3_600_000;
  if (Number.isInteger(hours)) return `${hours}h`;
  return `${Math.round(ms / 1000)}s`;
}

// --- forge delegations ---
//
// These keep the historical exported names used by src/api.ts. They resolve the
// forge per repository (settings preference -> origin host -> configured token),
// defaulting to GitLab so existing installations are unchanged.

/** List open merge/pull requests for the repository's resolved forge. */
export async function listMergeRequests(repoPath: string): Promise<ReviewRequest[]> {
  const forge = await resolveForge(repoPath);
  return forge.listRequests(repoPath);
}

/** Fetch one request with its changed files and diff refs. */
export async function getMergeRequestChanges(
  repoPath: string,
  iid: number,
): Promise<ReviewChanges> {
  const forge = await resolveForge(repoPath);
  return forge.getChanges(repoPath, iid);
}

/** Make the request head commit available to the read-only tools. */
export async function ensureMergeRequestRefs(
  repoPath: string,
  changes: ReviewChanges,
): Promise<{ fetched: boolean }> {
  return forgeByKind(changes.forge).ensureRefs(repoPath, changes);
}

/** Post one approved comment on the repository's forge. */
export async function createDiscussion(
  repoPath: string,
  iid: number,
  comment: ReviewComment,
  refs: DiffRefs,
  forgeKind?: ReviewChanges['forge'],
): Promise<string> {
  const forge = forgeKind ? forgeByKind(forgeKind) : await resolveForge(repoPath);
  return forge.postComment(repoPath, iid, comment, refs);
}

/** Approve a request on the repository's forge. */
export async function approveMergeRequest(
  repoPath: string,
  iid: number,
  forgeKind?: ReviewChanges['forge'],
): Promise<void> {
  const forge = forgeKind ? forgeByKind(forgeKind) : await resolveForge(repoPath);
  return forge.approve(repoPath, iid);
}

/** Cheap authenticated call used by the settings "Test" button (GitLab). */
export async function testGitLab(): Promise<string> {
  return gitlabForge.test();
}

/** Cheap authenticated call against an explicit forge (settings "Test"). */
export async function testForge(kind: ReviewChanges['forge']): Promise<string> {
  return forgeByKind(kind).test();
}

// --- OpenAI-compatible chat client ---

interface CompletionResult {
  content: string;
  toolCalls: ToolCall[];
}

interface ChatRequest {
  model: string;
  messages: unknown[];
  temperature: number;
  max_tokens: number;
  stream?: boolean;
  tools?: unknown;
  tool_choice?: string;
}

/**
 * Call `/chat/completions`, streaming when the provider opts in. Streamed text
 * is appended to `onDelta` so a job can show partial output.
 */
async function chatCompletion(
  provider: StoredProvider,
  request: ChatRequest,
  onDelta?: (chunk: string) => void,
  signal?: AbortSignal,
  labels: { cancelled?: string; timeout?: string } = {},
): Promise<CompletionResult> {
  const key = providerKey(provider);
  const url = `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  // Abort the request promptly when the job is cancelled, not after the timeout.
  const onAbort = (): void => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      const err = new Error(`AI endpoint ${res.status}: ${text}`) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }

    // Some local servers ignore `stream: true` and return a normal JSON body;
    // only treat the response as SSE when it actually says so.
    const contentType = res.headers.get('content-type') ?? '';
    if (request.stream && res.body && contentType.includes('text/event-stream')) {
      return await readStream(res.body, onDelta);
    }
    const raw = (await res.json()) as unknown;
    return parseCompletion(raw);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      // Distinguish a user cancellation from hitting the timeout.
      if (signal?.aborted) throw new Error(labels.cancelled ?? 'Review cancelled');
      throw new Error(labels.timeout ?? `AI request timed out after ${formatTimeout(HTTP_TIMEOUT_MS)}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

interface StreamDelta {
  content?: string;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

/** Consume an OpenAI SSE stream, accumulating content and tool-call fragments. */
async function readStream(
  body: ReadableStream<Uint8Array>,
  onDelta?: (chunk: string) => void,
): Promise<CompletionResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  const calls = new Map<number, { id: string; name: string; args: string }>();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') continue;
      let delta: StreamDelta | null = null;
      try {
        const parsed = JSON.parse(data) as { choices?: Array<{ delta?: StreamDelta }> };
        delta = parsed.choices?.[0]?.delta ?? null;
      } catch {
        continue;
      }
      if (!delta) continue;
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        content += delta.content;
        onDelta?.(delta.content);
      }
      for (const [i, tc] of (delta.tool_calls ?? []).entries()) {
        const index = tc.index ?? i;
        const cur = calls.get(index) ?? { id: '', name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name = tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        calls.set(index, cur);
      }
    }
  }

  const toolCalls: ToolCall[] = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, c]) => ({
      id: c.id || `stream_${index}`,
      name: c.name,
      args: parseArgs(c.args),
    }))
    .filter((c) => c.name.length > 0);

  return { content, toolCalls };
}

function parseCompletion(raw: unknown): CompletionResult {
  const choice = (raw as { choices?: Array<{ message?: Record<string, unknown> }> }).choices?.[0];
  const msg = choice?.message ?? {};
  const content = typeof msg.content === 'string' ? msg.content : '';
  const toolCalls: ToolCall[] = [];
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      const rec = tc as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
      const name = typeof rec.function?.name === 'string' ? rec.function.name : '';
      if (!name) continue;
      toolCalls.push({
        id: typeof rec.id === 'string' ? rec.id : `call_${toolCalls.length}`,
        name,
        args: parseArgs(
          typeof rec.function?.arguments === 'string' ? rec.function.arguments : '{}',
        ),
      });
    }
  }
  return { content, toolCalls };
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}') as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** One-shot completion used by the settings "Test AI" button. */
export async function testProvider(provider: StoredProvider): Promise<string> {
  const result = await chatCompletion(provider, {
    model: provider.model,
    messages: [
      { role: 'system', content: 'Reply with the single word: ok' },
      { role: 'user', content: 'ping' },
    ],
    temperature: 0,
    max_tokens: 16,
  });
  return result.content.trim() || '(empty response)';
}

// --- AI commit messages ---

/** Strip a markdown code fence and surrounding whitespace from a model reply. */
function cleanCommitMessage(raw: string): string {
  const unfenced = raw.replace(/^\s*```[^\n]*\n?/i, '').replace(/\n?```\s*$/i, '');
  return unfenced.trim();
}

/** System prompt for commit-message generation. */
function buildCommitSystemPrompt(rule: CommitMessageConfig, includeHistory: boolean): string {
  const lines = [
    'You write git commit messages.',
    `Write in ${rule.language}.`,
    rule.instructions,
    'Use the imperative mood in the subject line and keep it under 72 characters.',
    'Add a short body separated by a blank line only when it helps explain why.',
  ];
  if (includeHistory) {
    lines.push('Match the style of the recent commits shown below.');
  }
  lines.push(
    'Reply with the commit message only — no code fences, no preamble, no explanation.',
  );
  return lines.join('\n');
}

export interface CommitMessageInput {
  /** Unified diff text for the changes being committed. */
  diff: string;
  /** Recent commit subjects, newest first, for style matching. */
  history?: string[];
}

/**
 * Generate a commit message for the given changes with the active provider.
 * One-shot, low temperature; the same OpenAI-compatible endpoint reviews use.
 */
export async function generateCommitMessage(
  rule: CommitMessageConfig,
  input: CommitMessageInput,
  providerId?: string,
): Promise<string> {
  const provider =
    providerId !== undefined ? (providerById(providerId) ?? activeProvider()) : activeProvider();
  if (!provider) throw new Error('No AI provider configured — add one in Settings');
  if (!provider.model.trim()) throw new Error('No model set for the active AI provider');

  const history =
    rule.includeHistory && input.history && input.history.length > 0
      ? `Recent commits (newest first):\n${input.history.map((s) => `- ${s}`).join('\n')}`
      : '';
  const user = [
    'Changes to commit:',
    input.diff || '(no diff available)',
    history ? `\n${history}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const result = await chatCompletion(provider, {
    model: provider.model,
    messages: [
      { role: 'system', content: buildCommitSystemPrompt(rule, Boolean(history)) },
      { role: 'user', content: user },
    ],
    temperature: Math.min(provider.temperature, 0.5),
    max_tokens: Math.min(provider.maxTokens, 512),
  });
  return cleanCommitMessage(result.content);
}

/**
 * One-shot text completion (no tools), for callers outside the review agent
 * loop — e.g. the AI conflict resolver. Shares the same client, timeout, and
 * upstream-error handling as a review call.
 */
export async function completeText(
  provider: StoredProvider,
  system: string,
  user: string,
  opts: { maxTokens?: number; signal?: AbortSignal; onDelta?: (chunk: string) => void } = {},
): Promise<string> {
  const result = await chatCompletion(
    provider,
    {
      model: provider.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: provider.temperature,
      max_tokens: opts.maxTokens ?? provider.maxTokens,
      stream: provider.stream,
    },
    opts.onDelta,
    opts.signal,
    { cancelled: 'AI request cancelled', timeout: 'AI request timed out' },
  );
  return result.content;
}

// --- comment parsing ---

function coerceSeverity(v: unknown): ReviewSeverity {
  return v === 'error' || v === 'warning' || v === 'info' ? v : 'info';
}

const SEVERITY_RANK: Record<ReviewSeverity, number> = { info: 0, warning: 1, error: 2 };

/** Validate and normalize one raw model comment; null when it must be dropped. */
function validateComment(
  raw: unknown,
  known: Set<string>,
  rule: ReviewRuleConfig,
  id: string,
  stage: ReviewCommentStage,
): ReviewComment | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const c = raw as Record<string, unknown>;
  const filePath = typeof c.filePath === 'string' ? c.filePath : typeof c.path === 'string' ? c.path : '';
  const body = typeof c.body === 'string' ? c.body.trim() : typeof c.comment === 'string' ? c.comment.trim() : '';
  if (!filePath || !body) return null;
  if (known.size > 0 && !known.has(filePath)) return null;
  if (matchesAnyGlob(filePath, rule.ignoreGlobs)) return null;
  const severity = coerceSeverity(c.severity);
  if (SEVERITY_RANK[severity] < SEVERITY_RANK[rule.severityThreshold]) return null;
  const newLine = typeof c.newLine === 'number' && c.newLine > 0 ? Math.floor(c.newLine) : null;
  const oldLine = typeof c.oldLine === 'number' && c.oldLine > 0 ? Math.floor(c.oldLine) : null;
  const line = typeof c.line === 'number' && c.line > 0 ? Math.floor(c.line) : null;
  return {
    id,
    filePath,
    oldLine,
    newLine: newLine ?? (oldLine === null ? line : null),
    severity,
    body,
    status: 'pending',
    stage,
    discussionId: null,
    error: null,
  };
}

/** Validate, filter, and cap the model's raw comment objects. */
export function parseComments(
  raw: unknown,
  rule: ReviewRuleConfig,
  files: ReviewFile[],
): ReviewComment[] {
  const container =
    typeof raw === 'object' && raw !== null
      ? ((raw as Record<string, unknown>).comments ?? raw)
      : raw;
  if (!Array.isArray(container)) return [];
  const known = new Set(files.flatMap((f) => [f.newPath, f.oldPath]));
  const out: ReviewComment[] = [];
  for (const item of container) {
    const c = validateComment(item, known, rule, `c${out.length + 1}`, 'parsed');
    if (c) out.push(c);
  }
  return rule.maxComments > 0 ? out.slice(0, rule.maxComments) : out;
}

/** Yield every complete, balanced JSON object found in text, in order. */
function scanJsonObjects(text: string): Record<string, unknown>[] {
  const cleaned = text.replace(/```(?:json)?/gi, '');
  const out: Record<string, unknown>[] = [];
  const stack: number[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (c === undefined) break;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') stack.push(i);
    else if (c === '}') {
      const start = stack.pop();
      if (start === undefined) continue;
      try {
        const parsed = JSON.parse(cleaned.slice(start, i + 1)) as unknown;
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          out.push(parsed as Record<string, unknown>);
        }
      } catch {
        // Incomplete or invalid fragment; ignore and keep scanning.
      }
    }
  }
  return out;
}

/**
 * Scan partial model output for complete comment objects. These are previews
 * (`stage: 'pending'`) validated with the same rules as the final result, so the
 * live list can only ever show comments the final parse would also accept.
 */
export function parsePartialComments(
  text: string,
  rule: ReviewRuleConfig,
  files: ReviewFile[],
): ReviewComment[] {
  const known = new Set(files.flatMap((f) => [f.newPath, f.oldPath]));
  const out: ReviewComment[] = [];
  for (const obj of scanJsonObjects(text)) {
    const c = validateComment(obj, known, rule, `p${out.length + 1}`, 'pending');
    if (c) out.push(c);
  }
  return rule.maxComments > 0 ? out.slice(0, rule.maxComments) : out;
}

// --- review jobs ---

interface JobRecord {
  job: ReviewJob;
  controller: AbortController;
  cancelled: boolean;
  /** Set while a pause is in flight; distinguishes pause from cancellation. */
  paused: boolean;
  /** Repository the job reads from; kept off the wire so it never reaches the renderer. */
  repoPath: string;
  /** Monotonic counter for stable comment ids across streamed previews. */
  commentSeq: number;
  /** Persisted session id; also the job id so `/review/status` keeps working. */
  sessionId: string;
  createdAt: number;
  changes: ReviewChanges;
  rule: ReviewRuleConfig;
  /** Provider chosen at start; re-resolved by id on resume. */
  providerId: string | null;
  maxSteps: number;
  budget: number;
  /** Caller-supplied step cap, before provider/rule fallbacks. */
  requestedMaxSteps: number | null;
  /** Changed-file indices grouped into batches, preserving order. */
  batches: number[][];
  /** Protocols to try, in order (already resolved from `auto`). */
  candidates: ReviewProtocol[];
  /** Enough state to resume the current batch exactly where it stopped. */
  checkpoint: BatchCheckpoint | null;
}

const jobs = new Map<string, JobRecord>();

/** A protocol candidate is always concrete; never `auto`. */
function buildCandidates(provider: StoredProvider): ReviewProtocol[] {
  const protocol = effectiveProtocol(provider);
  if (protocol !== 'auto') return [protocol];
  return provider.detectedProtocol
    ? [provider.detectedProtocol, 'react', 'json', 'none']
    : ['native', 'react', 'json', 'none'];
}

/** Snapshot a live job as a persistable session. */
function snapshotSession(rec: JobRecord): StoredReviewSession {
  return {
    id: rec.sessionId,
    repoPath: rec.repoPath,
    createdAt: rec.createdAt,
    updatedAt: Date.now(),
    changes: rec.changes,
    rule: rec.rule,
    providerId: rec.providerId,
    maxSteps: rec.maxSteps,
    budget: rec.budget,
    batches: rec.batches,
    candidates: rec.candidates,
    batchIndex: Math.max(0, rec.job.batchIndex - 1),
    checkpoint: rec.checkpoint,
    job: rec.job,
  };
}

/** Persist a job, ignoring a read-only config directory. */
function persist(rec: JobRecord): void {
  try {
    writeSession(snapshotSession(rec));
  } catch {
    // A read-only config dir must not fail a review.
  }
}

/** List the persisted sessions for a repository, for the review UI. */
export function listReviewSessions(repoPath: string): ReviewSession[] {
  return listSessions(repoPath).map((s) => ({
    id: s.id,
    iid: s.changes.mr.iid,
    title: s.changes.mr.title,
    state: s.job.state,
    updatedAt: s.updatedAt,
    providerId: s.providerId,
    commentCount: s.job.comments.length,
    batchIndex: s.job.batchIndex,
    batchTotal: s.job.batchTotal,
    forge: s.changes.forge,
  }));
}

/** The public listing shape of one session. */
function publicSession(s: StoredReviewSession): ReviewSession {
  return {
    id: s.id,
    iid: s.changes.mr.iid,
    title: s.changes.mr.title,
    state: s.job.state,
    updatedAt: s.updatedAt,
    providerId: s.providerId,
    commentCount: s.job.comments.length,
    batchIndex: s.job.batchIndex,
    batchTotal: s.job.batchTotal,
    forge: s.changes.forge,
  };
}

/** A stored session as the UI restores it, using live state when the job is local. */
export function loadReviewSession(repoPath: string, id: string): ReviewSessionView | null {
  const live = jobs.get(id);
  if (live && live.repoPath === repoPath) {
    return { session: publicSession(snapshotSession(live)), changes: live.changes, job: structuredClone(live.job) };
  }
  const s = readSession(id);
  if (!s || s.repoPath !== repoPath) return null;
  return { session: publicSession(s), changes: s.changes, job: structuredClone(s.job) };
}

/** The repository a job (or a persisted session) belongs to, or null. */
export function reviewJobRepo(id: string): string | null {
  const live = jobs.get(id);
  if (live) return live.repoPath;
  return readSession(id)?.repoPath ?? null;
}

/** Persist user edits/approvals made in the renderer onto a stored session. */
export function saveReviewSessionComments(
  repoPath: string,
  id: string,
  comments: ReviewComment[],
): boolean {
  const live = jobs.get(id);
  if (live && live.repoPath === repoPath) {
    const byId = new Map(comments.map((c) => [c.id, c]));
    for (const c of live.job.comments) {
      const next = byId.get(c.id);
      if (!next) continue;
      c.body = next.body;
      c.status = next.status;
      c.discussionId = next.discussionId;
      c.error = next.error;
    }
    persist(live);
    return true;
  }
  const s = readSession(id);
  if (!s || s.repoPath !== repoPath) return false;
  const byId = new Map(comments.map((c) => [c.id, c]));
  for (const c of s.job.comments) {
    const next = byId.get(c.id);
    if (!next) continue;
    c.body = next.body;
    c.status = next.status;
    c.discussionId = next.discussionId;
    c.error = next.error;
  }
  s.updatedAt = Date.now();
  writeSession(s);
  return true;
}

/** Delete a persisted session; also drops its in-memory job when not running. */
export function deleteReviewSession(repoPath: string, id: string): boolean {
  const live = jobs.get(id);
  if (live && live.repoPath !== repoPath) return false;
  if (live && live.job.state === 'running') return false;
  const deleted = deleteSession(id);
  if (deleted && live) jobs.delete(id);
  return deleted;
}

/** Rebuild an in-memory job record from a persisted session. */
function recordFromStored(s: StoredReviewSession): JobRecord {
  return {
    job: s.job,
    controller: new AbortController(),
    cancelled: false,
    paused: false,
    repoPath: s.repoPath,
    commentSeq: s.job.comments.length,
    sessionId: s.id,
    createdAt: s.createdAt,
    changes: s.changes,
    rule: s.rule,
    providerId: s.providerId,
    maxSteps: s.maxSteps,
    budget: s.budget,
    requestedMaxSteps: s.maxSteps,
    batches: s.batches,
    candidates: s.candidates.length > 0 ? s.candidates : ['none'],
    checkpoint: s.checkpoint,
  };
}

/**
 * Merge newly seen comments into the job's live list. A comment is identified by
 * its anchor (file + line) when it has one, else by its body, so a streamed
 * preview and the validated final result collapse into one entry. Matching
 * previews are upgraded to `stage`. A `parsed` sync keeps comments already
 * validated in earlier batches and drops previews the final parse does not
 * contain; a `pending` sync merges into what is already shown.
 */
function syncComments(
  rec: JobRecord,
  incoming: ReviewComment[],
  stage: ReviewCommentStage,
): ReviewComment[] {
  const key = (c: ReviewComment): string =>
    `${c.filePath}\u0000${c.oldLine ?? ''}\u0000${c.newLine ?? ''}\u0000${
      c.oldLine === null && c.newLine === null ? c.body : ''
    }`;
  const existing = rec.job.comments;
  const next = stage === 'parsed' ? existing.filter((c) => c.stage === 'parsed') : [...existing];
  const inNext = new Set(next);
  const byKey = new Map<string, ReviewComment>(existing.map((c) => [key(c), c]));
  const seen = new Set<string>();
  for (const c of incoming) {
    const k = key(c);
    if (seen.has(k)) continue;
    seen.add(k);
    const match = byKey.get(k);
    if (match) {
      match.filePath = c.filePath;
      match.oldLine = c.oldLine;
      match.newLine = c.newLine;
      match.severity = c.severity;
      match.body = c.body;
      match.stage = stage;
      if (!inNext.has(match)) {
        next.push(match);
        inNext.add(match);
      }
    } else {
      c.id = `c${++rec.commentSeq}`;
      next.push(c);
      inNext.add(c);
      byKey.set(k, c);
    }
  }
  rec.job.comments = next;
  return next;
}

/** Snapshot of a job for `/review/status`. */
export function getReviewJob(id: string): ReviewJob | null {
  const rec = jobs.get(id);
  return rec ? structuredClone(rec.job) : null;
}

/** Abort an in-flight review job. Cancellation is terminal. */
export function cancelReviewJob(id: string): boolean {
  const rec = jobs.get(id);
  if (!rec || rec.job.state !== 'running') return false;
  rec.cancelled = true;
  rec.controller.abort();
  rec.job.state = 'cancelled';
  rec.checkpoint = null;
  persist(rec);
  return true;
}

/**
 * Pause an in-flight job: abort the current model call and keep the checkpoint
 * so it can be resumed. Distinct from cancellation, which discards the session.
 */
export function pauseReviewJob(id: string): boolean {
  const rec = jobs.get(id);
  if (!rec || rec.job.state !== 'running') return false;
  rec.paused = true;
  rec.job.state = 'paused';
  rec.controller.abort();
  persist(rec);
  return true;
}

/**
 * Resume a paused job. A live paused record continues from its checkpoint; a
 * record only on disk (server restart) is rebuilt and re-entered from the last
 * persisted checkpoint. Returns null when the session is gone or not paused.
 */
export function resumeReview(repoPath: string, id: string): ReviewJob | null {
  const live = jobs.get(id);
  if (live && live.repoPath === repoPath) {
    if (live.job.state !== 'paused') return null;
    live.paused = false;
    live.controller = new AbortController();
    live.job.state = 'running';
    live.job.error = null;
    void runReview(live).catch((err: unknown) => finishWithError(live, err));
    return structuredClone(live.job);
  }
  const s = readSession(id);
  if (!s || s.repoPath !== repoPath || s.job.state !== 'paused') return null;
  const rec = recordFromStored(s);
  rec.job.state = 'running';
  jobs.set(id, rec);
  void runReview(rec).catch((err: unknown) => finishWithError(rec, err));
  return structuredClone(rec.job);
}

function finishWithError(rec: JobRecord, err: unknown): void {
  if (rec.paused) rec.job.state = 'paused';
  else if (rec.cancelled) rec.job.state = 'cancelled';
  else {
    rec.job.state = 'error';
    rec.job.error = err instanceof Error ? err.message : String(err);
  }
  persist(rec);
}

function newJobRecord(repoPath: string, sessionId: string): JobRecord {
  const rec: JobRecord = {
    controller: new AbortController(),
    cancelled: false,
    paused: false,
    repoPath,
    commentSeq: 0,
    sessionId,
    createdAt: Date.now(),
    changes: { forge: 'gitlab', mr: { iid: 0, title: '', author: '', sourceBranch: '', targetBranch: '', state: '', webUrl: '', updatedAt: '', draft: false }, files: [], diffRefs: { baseSha: '', headSha: '', startSha: '' } },
    rule: reviewRule(),
    providerId: null,
    maxSteps: 8,
    budget: 4096,
    requestedMaxSteps: null,
    batches: [],
    candidates: [],
    checkpoint: null,
    job: {
      id: sessionId,
      state: 'running',
      protocol: null,
      batchIndex: 0,
      batchTotal: 1,
      output: '',
      trace: [],
      comments: [],
      error: null,
    },
  };
  jobs.set(sessionId, rec);
  // Keep the map bounded; drop the oldest finished job.
  if (jobs.size > 20) {
    for (const [key, value] of jobs) {
      if (value.job.state !== 'running' && value.job.state !== 'paused') {
        jobs.delete(key);
        break;
      }
    }
  }
  return rec;
}

/** Allocate a session id that does not collide with a stored one. */
function newSessionId(): string {
  for (let i = 1; ; i++) {
    const id = `rev${Date.now().toString(36)}${i.toString(36)}`;
    if (!readSession(id)) return id;
  }
}

export interface StartReviewOptions {
  repoPath: string;
  changes: ReviewChanges;
  providerId?: string;
  rule?: Partial<ReviewRuleConfig>;
  maxSteps?: number;
}

/** Start a review job and return it immediately; the loop runs in the background. */
export function startReview(opts: StartReviewOptions): ReviewJob {
  const rec = newJobRecord(opts.repoPath, newSessionId());
  rec.changes = opts.changes;
  rec.rule = { ...reviewRule(), ...opts.rule };
  rec.providerId = opts.providerId ?? null;
  rec.requestedMaxSteps = opts.maxSteps ?? null;
  void runReview(rec).catch((err: unknown) => finishWithError(rec, err));
  return structuredClone(rec.job);
}

/** The protocol to use: the provider's configured one, with `auto` resolved. */
function effectiveProtocol(provider: StoredProvider): ToolProtocol {
  if (provider.toolProtocol !== 'auto') return provider.toolProtocol;
  return provider.detectedProtocol ?? 'auto';
}

/** Pack changed files into context-sized batches, preserving order. */
function batchFileIndices(
  files: ReviewFile[],
  budgetTokens: number,
  enabled: boolean,
): number[][] {
  if (!enabled || files.length === 0) return [files.map((_, i) => i)];
  const batches: number[][] = [];
  let current: number[] = [];
  let size = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (!f) continue;
    const cost = Math.ceil((f.diff.length + f.newPath.length) / 4) + 16;
    if (current.length > 0 && size + cost > budgetTokens) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(i);
    size += cost;
  }
  if (current.length > 0) batches.push(current);
  return batches.length > 0 ? batches : [files.map((_, i) => i)];
}

/** Resolve the provider, erroring with the same message the first run used. */
function requireProvider(providerId: string | null): StoredProvider {
  const provider =
    providerId !== null ? (providerById(providerId) ?? activeProvider()) : activeProvider();
  if (!provider) throw new Error('No AI provider configured — add one in Settings');
  if (!provider.model.trim()) throw new Error('No model set for the active AI provider');
  return provider;
}

/** Set up the batch plan and candidate protocols on the first run. */
function planReview(rec: JobRecord): StoredProvider {
  const provider = requireProvider(rec.providerId);
  rec.providerId = provider.id;
  rec.maxSteps = Math.max(1, rec.requestedMaxSteps ?? provider.maxSteps ?? rec.rule.maxSteps);
  rec.budget = Math.max(1024, provider.contextWindow - provider.maxTokens - 256);
  if (rec.batches.length === 0) {
    const relevant = rec.changes.files.filter((f) => {
      const p = f.newPath || f.oldPath;
      return p && !matchesAnyGlob(p, rec.rule.ignoreGlobs);
    });
    const source = relevant.length > 0 ? relevant : rec.changes.files;
    // Store indices into the full file list so a restored session can rebuild.
    const all = rec.changes.files;
    const subset = source.map((f) => all.indexOf(f)).filter((i) => i >= 0);
    rec.batches = batchFileIndices(
      source,
      Math.floor(rec.budget * 0.7),
      rec.rule.batchByFile,
    ).map((b) => b.map((i) => subset[i] ?? -1).filter((i) => i >= 0));
  }
  rec.job.batchTotal = rec.batches.length;
  if (rec.candidates.length === 0) rec.candidates = buildCandidates(provider);
  return provider;
}

async function runReview(rec: JobRecord): Promise<void> {
  const provider = planReview(rec);
  const maxSteps = rec.maxSteps;
  const budget = rec.budget;

  for (let i = rec.job.batchIndex > 0 ? rec.job.batchIndex - 1 : 0; i < rec.batches.length; i++) {
    if (rec.cancelled || rec.paused) return;
    const indices = rec.batches[i] ?? [];
    rec.job.batchIndex = i + 1;
    rec.job.output = '';

    let lastError: Error | null = null;
    let batchComments: ReviewComment[] | null = null;
    const startCandidate = rec.checkpoint?.batchIndex === i ? rec.checkpoint.candidateIndex : 0;
    for (let ci = startCandidate; ci < rec.candidates.length; ci++) {
      if (rec.cancelled || rec.paused) return;
      const candidate = rec.candidates[ci];
      if (!candidate) continue;
      try {
        const result = await runBatch(rec, provider, candidate, maxSteps, budget, indices);
        rec.job.protocol = candidate;
        if (provider.toolProtocol === 'auto' && provider.detectedProtocol !== candidate) {
          rememberProtocol(provider.id, candidate);
          provider.detectedProtocol = candidate;
        }
        batchComments = result;
        rec.checkpoint = null;
        break;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // A 4xx from a native tool request usually means tools are unsupported.
        if (candidate !== 'none') continue;
      }
    }

    if (batchComments === null) {
      if (rec.paused || rec.cancelled) return;
      throw lastError ?? new Error('Review failed');
    }
    syncComments(rec, batchComments, 'parsed');
    persist(rec);
    if (rec.rule.maxComments > 0 && rec.job.comments.length >= rec.rule.maxComments) break;
  }

  rec.job.state = 'done';
  rec.checkpoint = null;
  persist(rec);
}

async function runBatch(
  rec: JobRecord,
  provider: StoredProvider,
  protocol: Exclude<ToolProtocol, 'auto'>,
  maxSteps: number,
  budget: number,
  indices: number[],
): Promise<ReviewComment[]> {
  const changes = rec.changes;
  const rule = rec.rule;
  const batch = indices.map((i) => changes.files[i]).filter((f): f is ReviewFile => f !== undefined);
  const adapter = adapterFor(protocol);
  const ctx: ToolContext = {
    repoPath: rec.repoPath,
    headRef: changes.diffRefs.headSha || 'HEAD',
    files: changes.files,
    toolResultChars: provider.toolResultChars,
  };

  const batchIndex = Math.max(0, rec.job.batchIndex - 1);
  const base = buildSystemPrompt(rule, changes, batch, protocol);
  const fresh: ChatMessage[] = [
    { role: 'system', content: base },
    {
      role: 'user',
      content:
        'Review the merge request changes above and return the review result as JSON with a ' +
        '`comments` array. Only comment on files present in the changes.',
    },
  ];
  // Reuse a checkpoint only when it belongs to the batch and protocol we are
  // about to run; otherwise start this batch fresh.
  const candidateIndex = rec.candidates.indexOf(protocol);
  const cp = rec.checkpoint;
  const resume =
    cp !== null && cp.batchIndex === batchIndex && cp.candidateIndex === candidateIndex;
  const messages: ChatMessage[] = resume ? cp.messages : fresh;
  // The checkpoint stores the step about to run; re-issue that same step.
  let step = resume ? cp.step - 1 : 0;

  for (;;) {
    if (rec.cancelled || rec.paused) return [];
    step++;
    pruneMessages(messages, budget);
    // Checkpoint before the model call: if we are paused mid-call, resume
    // re-issues this step rather than skipping its result.
    rec.checkpoint = { batchIndex, candidateIndex, messages, step };
    persist(rec);

    // Scan the streamed text for complete comment objects and surface them as
    // pending previews so the UI list fills in while the model is still writing.
    let liveText = '';
    let lastScan = 0;
    const scanLive = (): void => {
      const now = Date.now();
      if (now - lastScan < 300) return;
      lastScan = now;
      const previews = parsePartialComments(liveText, rule, changes.files);
      if (previews.length > 0) syncComments(rec, previews, 'pending');
    };

    const useNativeTools = adapter.native;
    const result = await chatCompletion(
      provider,
      {
        model: provider.model,
        messages: messages.map(toWire(useNativeTools)),
        temperature: provider.temperature,
        max_tokens: provider.maxTokens,
        stream: provider.stream,
        ...(useNativeTools ? { tools: nativeTools(), tool_choice: 'auto' } : {}),
      },
      (chunk) => {
        rec.job.output += chunk;
        rec.job.output = rec.job.output.slice(-4000);
        liveText += chunk;
        scanLive();
      },
      rec.controller.signal,
    );

    const parsed = adapter.parse(
      useNativeTools
        ? { content: result.content, tool_calls: result.toolCalls.map((c) => ({ id: c.id, function: { name: c.name, arguments: JSON.stringify(c.args) } })) }
        : { content: result.content },
    );

    // Non-streamed responses never hit the delta callback; scan the whole text.
    if (parsed.content.length > 0) {
      const previews = parsePartialComments(parsed.content, rule, changes.files);
      if (previews.length > 0) syncComments(rec, previews, 'pending');
    }

    const obj = extractJsonObject(parsed.content);
    const isFinal =
      parsed.toolCalls.length === 0 &&
      obj !== null &&
      ('comments' in obj || Array.isArray(obj.comments));
    if (isFinal) {
      return parseComments(obj, rule, changes.files);
    }

    if (parsed.toolCalls.length === 0) {
      // No tool calls and no valid final JSON: try a plain extraction, else fail
      // the candidate so the caller can fall back to another protocol.
      const fallback = extractJsonObject(parsed.content);
      if (fallback) return parseComments(fallback, rule, changes.files);
      if (obj === null && parsed.content.trim().length > 0 && protocol !== 'none') {
        throw new Error('model did not return a tool call or valid JSON');
      }
      return [];
    }

    messages.push({ role: 'assistant', content: parsed.content, toolCalls: parsed.toolCalls });
    for (const call of parsed.toolCalls) {
      if (rec.cancelled || rec.paused) return [];
      const started = Date.now();
      let output: string;
      try {
        output = await executeTool(ctx, call.name, call.args);
      } catch (err) {
        output = `error: ${err instanceof Error ? err.message : String(err)}`;
      }
      const trace: ReviewTraceStep = {
        step,
        tool: call.name,
        args: call.args,
        resultSummary: summarizeResult(output),
        durationMs: Date.now() - started,
      };
      rec.job.trace.push(trace);
      messages.push({ role: 'tool', content: output, toolCallId: call.id });
    }

    if (step >= maxSteps) {
      // Out of steps: ask for the final JSON using what we have.
      messages.push({
        role: 'user',
        content: 'Stop exploring. Return the final JSON review result now.',
      });
      const finalResult = await chatCompletion(
        provider,
        {
          model: provider.model,
          messages: messages.map(toWire(false)),
          temperature: provider.temperature,
          max_tokens: provider.maxTokens,
        },
        undefined,
        rec.controller.signal,
      );
      const finalObj = extractJsonObject(finalResult.content);
      return finalObj ? parseComments(finalObj, rule, changes.files) : [];
    }
  }
}

function buildSystemPrompt(
  rule: ReviewRuleConfig,
  changes: ReviewChanges,
  batch: ReviewFile[],
  protocol: Exclude<ToolProtocol, 'auto'>,
): string {
  const useTools = protocol !== 'none';
  const adapter = adapterFor(protocol);
  const files = batch
    .map((f) => `- ${f.newPath}${f.newFile ? ' (new)' : ''}${f.deletedFile ? ' (deleted)' : ''}`)
    .join('\n');
  const diffs = batch
    .map((f) => `### ${f.newPath}\n${f.diff || '(binary or empty diff)'}`)
    .join('\n\n');
  const lines = [
    `You are reviewing a ${forgeLabel(changes.forge)} for the Liana project.`,
    `Write in ${rule.language}.`,
    rule.instructions,
    '',
    `${changes.forge === 'github' ? 'Pull request' : 'Merge request'} #${changes.mr.iid}: ${changes.mr.title}`,
    `Branches: ${changes.mr.sourceBranch} → ${changes.mr.targetBranch}`,
    '',
    'Changed files:',
    files,
    '',
    'Diff:',
    diffs,
  ];
  if (useTools && !adapter.native) {
    lines.push(
      '',
      'You can read the wider repository with the tools below. Prefer inspecting ' +
        'related code before commenting. Tools read the MR head, not the working tree.',
    );
  }
  let out = lines.join('\n');
  if (useTools) out += `\n\n${adapter.guidance(TOOLS)}`;
  out +=
    '\n\nReturn the final result as JSON: {"comments":[{"filePath":"…","newLine":N,' +
    '"oldLine":N,"severity":"info|warning|error","body":"…"}]}. ' +
    'newLine/oldLine are 1-based line numbers in the diff; omit whichever does not apply.';
  return out;
}

/** Native `tools` payload sent to OpenAI-compatible endpoints. */
function nativeTools(): unknown[] {
  return TOOLS.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/** Serialize a chat message in OpenAI wire format. */
function toWire(native: boolean): (m: ChatMessage) => Record<string, unknown> {
  return (m) => {
    if (m.role === 'tool') {
      return native
        ? { role: 'tool', content: m.content, tool_call_id: m.toolCallId ?? '' }
        : { role: 'user', content: `Observation: ${m.content}` };
    }
    if (m.role === 'assistant' && m.toolCalls && native) {
      return {
        role: 'assistant',
        content: m.content,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      };
    }
    return { role: m.role, content: m.content };
  };
}

/** Drop/condense oldest tool results when the context budget is exceeded. */
function pruneMessages(messages: ChatMessage[], budget: number): void {
  if (messagesTokens(messages) <= budget) return;
  for (let i = 1; i < messages.length - 4; i++) {
    const m = messages[i];
    if (m && m.role === 'tool' && m.content.length > 200) {
      m.content = `(earlier observation, condensed) ${summarizeResult(m.content)}`;
    }
  }
}
