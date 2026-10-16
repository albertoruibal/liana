// Review jobs: the bounded, pausable read-only agent loop plus its persistence.
// Node-only.

import {
  activeProvider,
  providerById,
  reviewRule,
  type StoredProvider,
} from '../settings';
import { forgeLabel, hasCommit } from '../forge';
import {
  executeTool,
  estimateTokens,
  matchesAnyGlob,
  messagesTokens,
  summarizeResult,
  TOOLS,
  type ChatMessage,
  type ToolCall,
  type ToolContext,
} from '../review-tools';
import {
  deleteSession,
  listSessions,
  readSession,
  writeSession,
  type BatchCheckpoint,
  type StoredReviewSession,
} from '../sessions';
import type {
  ReviewChanges,
  ReviewComment,
  ReviewCommentStage,
  ReviewFile,
  ReviewJob,
  ReviewPromptStep,
  ReviewRuleConfig,
  ReviewSession,
  ReviewSessionView,
  ReviewTraceStep,
} from '../types';
import { chatCompletion, type ChatRequest, type CompletionResult } from './ai';
import { commentFromTool } from './comments';

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
  budget: number;
  /**
   * Observed real/estimated prompt-token ratio (monotonic, clamped). The
   * chars/3.5 estimate under-counts code, so the enforced budget is shrunk by
   * this factor to stay ahead of a local server's silent prompt truncation.
   */
  tokenDrift: number;
  /** Changed-file indices grouped into batches, preserving order. */
  batches: number[][];
  /** Enough state to resume the current batch exactly where it stopped. */
  checkpoint: BatchCheckpoint | null;
}

const jobs = new Map<string, JobRecord>();

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
    budget: rec.budget,
    tokenDrift: rec.tokenDrift,
    batches: rec.batches,
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
    llmDurationMs: s.job.llmDurationMs,
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
    llmDurationMs: s.job.llmDurationMs,
    forge: s.changes.forge,
  };
}

/** A stored session as the UI restores it, using live state when the job is local. */
export function loadReviewSession(repoPath: string, id: string): ReviewSessionView | null {
  const live = jobs.get(id);
  if (live && live.repoPath === repoPath) {
    return { session: publicSession(snapshotSession(live)), changes: live.changes, job: leanJob(structuredClone(live.job)) };
  }
  const s = readSession(id);
  if (!s || s.repoPath !== repoPath) return null;
  return { session: publicSession(s), changes: s.changes, job: leanJob(structuredClone(s.job)) };
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
    budget: s.budget,
    tokenDrift: s.tokenDrift,
    batches: s.batches,
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

/**
 * A job with the bulky model log stripped for the polling renderer. Full prompt
 * text is dropped for every step and the streamed response is kept only for the
 * in-flight (last) call, so the live output pane still streams; each completed
 * step is fetched on demand from `/review/log`.
 */
function leanJob(job: ReviewJob): ReviewJob {
  const last = job.prompts.length - 1;
  return {
    ...job,
    prompts: job.prompts.map((p, i) => ({
      ...p,
      text: '',
      segments: i === last ? p.segments : [],
    })),
  };
}

/** Snapshot of a job for `/review/status`. */
export function getReviewJob(id: string): ReviewJob | null {
  const rec = jobs.get(id);
  return rec ? leanJob(structuredClone(rec.job)) : null;
}

/**
 * The full logged step at `index`, from the live job when present else from the
 * session on disk. Powers the model log's per-step on-demand loading.
 */
export function getReviewLog(id: string, index: number): ReviewPromptStep | null {
  const live = jobs.get(id);
  const prompts = live ? live.job.prompts : readSession(id)?.job.prompts;
  if (!prompts || index < 0 || index >= prompts.length) return null;
  const prompt = prompts[index];
  return prompt ? structuredClone(prompt) : null;
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
 * Resume a paused or errored job. A live record continues from its checkpoint;
 * a record only on disk (server restart) is rebuilt and re-entered from the last
 * persisted checkpoint. An errored job may carry no checkpoint — it then
 * re-runs its current batch from scratch, keeping comments already collected.
 * Returns null when the session is gone or not resumable.
 */
export function resumeReview(repoPath: string, id: string): ReviewJob | null {
  const live = jobs.get(id);
  if (live && live.repoPath === repoPath) {
    if (live.job.state !== 'paused' && live.job.state !== 'error') return null;
    live.paused = false;
    live.controller = new AbortController();
    live.job.state = 'running';
    live.job.error = null;
    live.job.stalledBatch = null;
    void runReview(live).catch((err: unknown) => finishWithError(live, err));
    return leanJob(structuredClone(live.job));
  }
  const s = readSession(id);
  if (!s || s.repoPath !== repoPath || (s.job.state !== 'paused' && s.job.state !== 'error')) return null;
  const rec = recordFromStored(s);
  rec.job.state = 'running';
  rec.job.error = null;
  rec.job.stalledBatch = null;
  jobs.set(id, rec);
  void runReview(rec).catch((err: unknown) => finishWithError(rec, err));
  return leanJob(structuredClone(rec.job));
}

/**
 * Resume a review from the logged model call at prompt `index`. The conversation
 * is rebuilt from that call's recorded request, so the agent re-issues that step.
 * The later steps of the SAME batch are dropped (they will be regenerated); the
 * later batches are kept and the run continues through them, so it picks up at
 * the next batch after this one. Refuses while the job is running. Returns null
 * when the session, the step, or its recorded conversation is unavailable.
 */
export function resumeReviewAtStep(repoPath: string, id: string, index: number): ReviewJob | null {
  const live = jobs.get(id);
  let rec: JobRecord;
  if (live && live.repoPath === repoPath) {
    rec = live;
  } else {
    const s = readSession(id);
    if (!s || s.repoPath !== repoPath) return null;
    rec = recordFromStored(s);
    jobs.set(id, rec);
  }
  if (rec.job.state === 'running') return null;
  const prompt = rec.job.prompts[index];
  if (!prompt) return null;
  const messages = messagesFromPrompt(prompt.text);
  if (!messages) return null;
  // Re-issuing this step makes the later steps of this batch obsolete: drop them
  // so the model log stays ordered and does not double up. Later batches remain.
  const batch = prompt.batchIndex;
  const step = prompt.step;
  rec.job.prompts = rec.job.prompts.filter((p) => !(p.batchIndex === batch && p.step > step));
  rec.job.trace = rec.job.trace.filter((t) => !(t.batchIndex === batch && t.step > step));
  rec.checkpoint = { batchIndex: Math.max(0, batch - 1), messages, step };
  rec.cancelled = false;
  rec.paused = false;
  rec.controller = new AbortController();
  rec.job.state = 'running';
  rec.job.error = null;
  rec.job.stalledBatch = null;
  rec.job.batchIndex = batch;
  rec.job.batchStep = step;
  persist(rec);
  void runReview(rec).catch((err: unknown) => finishWithError(rec, err));
  return leanJob(structuredClone(rec.job));
}

function isRecordForLog(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Parse a tool call's serialized arguments, tolerating anything malformed. */
function parseArgs(v: unknown): Record<string, unknown> {
  if (typeof v !== 'string') return {};
  try {
    const parsed = JSON.parse(v) as unknown;
    return isRecordForLog(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Rebuild the agent conversation from a logged prompt's serialized request. The
 * log stores the exact wire messages (`toWire`), so this inverts that shape to
 * reissue the call. Returns null when the text is absent or not the expected
 * shape, so a resume-from-step fails cleanly instead of sending a broken prompt.
 */
function messagesFromPrompt(text: string): ChatMessage[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecordForLog(parsed) || !Array.isArray(parsed.messages)) return null;
  const out: ChatMessage[] = [];
  for (const raw of parsed.messages) {
    if (!isRecordForLog(raw)) return null;
    const role = raw.role;
    if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') return null;
    const msg: ChatMessage = { role, content: typeof raw.content === 'string' ? raw.content : '' };
    if (role === 'tool') {
      if (typeof raw.tool_call_id === 'string') msg.toolCallId = raw.tool_call_id;
    } else if (role === 'assistant' && Array.isArray(raw.tool_calls)) {
      msg.toolCalls = raw.tool_calls.map((c) => {
        const call = isRecordForLog(c) ? c : {};
        const fn = isRecordForLog(call.function) ? call.function : {};
        return {
          id: typeof call.id === 'string' ? call.id : '',
          name: typeof fn.name === 'string' ? fn.name : '',
          args: parseArgs(fn.arguments),
        };
      });
    }
    out.push(msg);
  }
  return out;
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
  const rule = reviewRule();
  const rec: JobRecord = {
    controller: new AbortController(),
    cancelled: false,
    paused: false,
    repoPath,
    commentSeq: 0,
    sessionId,
    createdAt: Date.now(),
    changes: { forge: 'gitlab', mr: { iid: 0, title: '', author: '', sourceBranch: '', targetBranch: '', state: '', webUrl: '', updatedAt: '', draft: false }, files: [], diffRefs: { baseSha: '', headSha: '', startSha: '' } },
    rule,
    providerId: null,
    budget: 4096,
    tokenDrift: 1,
    batches: [],
    checkpoint: null,
    job: {
      id: sessionId,
      state: 'running',
      batchIndex: 0,
      batchTotal: 1,
      batchStep: 0,
      trace: [],
      prompts: [],
      llmDurationMs: 0,
      comments: [],
      error: null,
      stalledBatch: null,
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
}

/** Start a review job and return it immediately; the loop runs in the background. */
export function startReview(opts: StartReviewOptions): ReviewJob {
  const rec = newJobRecord(opts.repoPath, newSessionId());
  rec.changes = opts.changes;
  rec.rule = { ...reviewRule(), ...opts.rule };
  rec.providerId = opts.providerId ?? null;
  void runReview(rec).catch((err: unknown) => finishWithError(rec, err));
  return leanJob(structuredClone(rec.job));
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
    const cost = Math.ceil((f.diff.length + f.newPath.length) / 3.5) + 16;
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

/**
 * Fraction of the model budget a batch's diff may occupy; the remainder is
 * headroom for the agent's tool results before `pruneMessages` kicks in.
 */
const BATCH_BUDGET_FRACTION = 0.5;

/**
 * Context share reserved for the model's output when the provider's `maxTokens`
 * is unlimited (`0`): the input budget gets the rest.
 */
const OUTPUT_RESERVE_FRACTION = 0.25;

/**
 * Upper clamp on the adaptive token-budget calibration. When the endpoint
 * reports real `usage.promptTokens`, the drift between it and the chars/3.5
 * estimate grows the enforced shrink factor up to this much; the estimate
 * under-counts code, and a prompt past the real window makes local servers
 * truncate from the left — dropping the system prompt mid-review.
 */
const MAX_TOKEN_DRIFT = 2;

/** Corrective user nudges per batch before a tool-free turn force-ends the batch. */
const MAX_NUDGES = 2;

/**
 * Consecutive turns whose tool calls are identical (same names and arguments)
 * before the batch is treated as a loop and force-ended. Small local models can
 * spin on the same call forever; the per-call hint alone never stops them.
 */
const MAX_REPEAT_ROUNDS = 3;

/** Word-3-gram overlap above which two assistant turns count as repetition. */
const REPEAT_OVERLAP = 0.6;

/** Repetition is compared over at most the trailing window of each message. */
const REPEAT_WINDOW_CHARS = 4000;

/** Set up the batch plan on the first run. */
function planReview(rec: JobRecord): StoredProvider {
  const provider = requireProvider(rec.providerId);
  rec.providerId = provider.id;
  // Reserve headroom for the model's output. With unlimited output tokens
  // (`maxTokens === 0`) reserve a fraction of the context window instead, so the
  // input budget never collapses.
  const outputReserve =
    provider.maxTokens > 0 ? provider.maxTokens : Math.floor(provider.contextWindow * OUTPUT_RESERVE_FRACTION);
  rec.budget = Math.max(1024, provider.contextWindow - outputReserve - 256);
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
      Math.floor(rec.budget * BATCH_BUDGET_FRACTION),
      rec.rule.batchByFile,
    ).map((b) => b.map((i) => subset[i] ?? -1).filter((i) => i >= 0));
  }
  rec.job.batchTotal = rec.batches.length;
  return provider;
}

async function runReview(rec: JobRecord): Promise<void> {
  const provider = planReview(rec);

  for (let i = rec.job.batchIndex > 0 ? rec.job.batchIndex - 1 : 0; i < rec.batches.length; i++) {
    if (rec.cancelled || rec.paused) return;
    const indices = rec.batches[i] ?? [];
    rec.job.batchIndex = i + 1;
    rec.job.batchStep = 0;

    const outcome = await runBatch(rec, provider, indices);
    // A batch that loops or dead-ends without finish_batch pauses the review at
    // this batch and keeps its checkpoint, so the user can continue it. Comments
    // collected so far are already live. The next batch is what the cursor holds.
    if (outcome.endedAbruptly) {
      rec.job.state = 'paused';
      rec.job.stalledBatch = rec.job.batchIndex;
      rec.job.error = null;
      persist(rec);
      return;
    }
    rec.checkpoint = null;
    syncComments(rec, outcome.comments, 'parsed');
    persist(rec);
    if (rec.rule.maxComments > 0 && rec.job.comments.length >= rec.rule.maxComments) break;
  }

  rec.job.state = 'done';
  rec.checkpoint = null;
  persist(rec);
}

/**
 * Record the exact request sent to the model, untruncated, for the model log.
 * The full text (and response) is kept in memory and persisted to disk; the
 * renderer gets a lean copy and loads each step on demand.
 */
function recordPrompt(rec: JobRecord, step: number, request: ChatRequest): ReviewPromptStep {
  const { messages, ...rest } = request;
  const text = JSON.stringify({ ...rest, messages }, null, 2);
  const entry: ReviewPromptStep = {
    batchIndex: rec.job.batchIndex,
    step,
    text,
    chars: text.length,
    truncated: false,
    durationMs: 0,
    promptTokens: null,
    completionTokens: null,
    usageEstimated: false,
    segments: [],
  };
  rec.job.prompts.push(entry);
  return entry;
}

/**
  * Attach wall-clock time and token counts to a logged prompt. Real `usage`
  * from the endpoint is preferred; when it is absent fall back to the chars/3.5
  * estimate and flag it as such. Real usage also calibrates the budget drift.
 */
function recordUsage(
  rec: JobRecord,
  entry: ReviewPromptStep,
  startedAt: number,
  result: CompletionResult,
  messages: ChatMessage[],
): void {
  entry.durationMs = Date.now() - startedAt;
  rec.job.llmDurationMs += entry.durationMs;
  if (result.usage) {
    entry.promptTokens = result.usage.promptTokens;
    entry.completionTokens = result.usage.completionTokens;
    entry.usageEstimated = false;
    // Calibrate: when the endpoint reports the real prompt size, remember how
    // much bigger it is than our estimate and shrink the enforced budget by
    // that factor (monotonic, clamped) so pruning stays ahead of truncation.
    const est = Math.max(1, messagesTokens(messages));
    const drift = result.usage.promptTokens / est;
    if (Number.isFinite(drift) && drift > rec.tokenDrift) {
      rec.tokenDrift = Math.min(MAX_TOKEN_DRIFT, drift);
    }
  } else {
    entry.promptTokens = messagesTokens(messages);
    entry.completionTokens = estimateTokens(result.content);
    entry.usageEstimated = true;
  }
}

/** How a batch ended: its comments, plus whether it was force-ended (loop/dead-end). */
interface BatchResult {
  comments: ReviewComment[];
  endedAbruptly: boolean;
}

async function runBatch(
  rec: JobRecord,
  provider: StoredProvider,
  indices: number[],
): Promise<BatchResult> {
  const changes = rec.changes;
  const rule = rec.rule;
  const batch = indices.map((i) => changes.files[i]).filter((f): f is ReviewFile => f !== undefined);
  const headRef = changes.diffRefs.headSha.trim();
  // The repository tools must read the MR head, never the local working tree or a
  // stale branch. Without the head commit there is no correct code to verify
  // against, so the review cannot run: fail with an actionable message rather
  // than silently reviewing the diff alone.
  const headAvailable = headRef !== '' && (await hasCommit(rec.repoPath, headRef).catch(() => false));
  if (!headAvailable) {
    throw new Error(
      `The ${forgeLabel(changes.forge)} head commit is not available locally — ` +
        'use "Checkout branch" to fetch it, then start the review again.',
    );
  }
  const ctx: ToolContext = {
    repoPath: rec.repoPath,
    headRef,
    toolResultChars: provider.toolResultChars,
  };

  const batchIndex = Math.max(0, rec.job.batchIndex - 1);
  const base = buildSystemPrompt(rule, changes, batch, rec.job.batchIndex, rec.job.batchTotal);
  const fresh: ChatMessage[] = [
    { role: 'system', content: base },
    {
      role: 'user',
      content:
        'Review the merge request changes above. Report each issue by calling add_comment; ' +
        'only comment on the files listed above. When you are done, call finish_batch.',
    },
  ];
  // Reuse a checkpoint only when it belongs to the batch we are about to run;
  // otherwise start this batch fresh.
  const cp = rec.checkpoint;
  const resume = cp !== null && cp.batchIndex === batchIndex;
  const messages: ChatMessage[] = resume ? cp.messages : fresh;
  // The checkpoint stores the step about to run; re-issue that same step.
  let step = resume ? cp.step - 1 : 0;
  // Comments added this batch, accumulated across turns.
  const batchComments: ReviewComment[] = [];
  // Anti-drift state for this batch: the last assistant prose, its last tool
  // calls, and the nudge counter. Reset per batch.
  let lastAssistantText = '';
  let lastCalls: ToolCall[] = [];
  let nudges = 0;
  // Loop detection: the previous turn's tool-call signature and how many
  // consecutive turns repeated it.
  let lastRoundSig: string | null = null;
  let repeatRounds = 0;

  for (;;) {
    if (rec.cancelled || rec.paused) return { comments: batchComments, endedAbruptly: false };
    step++;
    rec.job.batchStep = step;
    pruneMessages(messages, effectiveBudget(rec));
    // Checkpoint before the model call: if we are paused mid-call, resume
    // re-issues this step rather than skipping its result.
    rec.checkpoint = { batchIndex, messages, step };
    persist(rec);

    let sawDelta = false;
    let sawReasoningDelta = false;

    const wire = messages.map(toWire());
    const request: ChatRequest = {
      model: provider.model,
      messages: wire,
      temperature: provider.temperature,
      // `0` means unlimited: omit the field so the server uses its own cap.
      ...(provider.maxTokens > 0 ? { max_tokens: provider.maxTokens } : {}),
      stream: true,
      stream_options: { include_usage: true },
      tools: nativeTools(),
      tool_choice: 'auto',
    };
    const promptEntry = recordPrompt(rec, step, request);
    // Record the streamed response as ordered segments so content and reasoning
    // stay interleaved; the full response is kept untruncated.
    const appendSeg = (kind: 'content' | 'reasoning', text: string): void => {
      if (text.length === 0) return;
      const last = promptEntry.segments[promptEntry.segments.length - 1];
      if (last && last.kind === kind) last.text += text;
      else promptEntry.segments.push({ kind, text });
    };
    const modelStarted = Date.now();
    const result = await chatCompletion(
      provider,
      request,
      (chunk) => {
        sawDelta = true;
        appendSeg('content', chunk);
      },
      rec.controller.signal,
      {},
      (chunk) => {
        sawReasoningDelta = true;
        appendSeg('reasoning', chunk);
      },
    );
    recordUsage(rec, promptEntry, modelStarted, result, messages);

    const parsed = { content: result.content, toolCalls: result.toolCalls };

    // Non-streamed responses never hit the delta callbacks; record the whole
    // response once so the log still shows it.
    if (!sawDelta && !sawReasoningDelta) {
      if (result.reasoning.length > 0) appendSeg('reasoning', result.reasoning);
      if (result.content.length > 0) appendSeg('content', result.content);
    }
    // Persist the completed call so its output/reasoning survives a restart.
    persist(rec);

    // Termination is explicit: only a `finish_batch` tool call ends the batch. A
    // tool-free turn is an abrupt ending — nudge the model to keep reviewing or
    // to call finish_batch, bounded by MAX_NUDGES so the batch still terminates.
    if (parsed.toolCalls.length === 0) {
      if (nudges >= MAX_NUDGES) return { comments: batchComments, endedAbruptly: true };
      nudges++;
      const repeated = looksRepeated(parsed.content, lastAssistantText);
      messages.push({ role: 'assistant', content: parsed.content });
      messages.push({
        role: 'user',
        content: nudgeMessage(repeated, batchComments.length),
      });
      lastAssistantText = parsed.content;
      continue;
    }

    messages.push({ role: 'assistant', content: parsed.content, toolCalls: parsed.toolCalls });
    if (parsed.content.length > 0) lastAssistantText = parsed.content;
    let finished = false;
    for (const call of parsed.toolCalls) {
      if (rec.cancelled || rec.paused) return { comments: batchComments, endedAbruptly: false };
      const started = Date.now();
      let output: string;
      if (call.name === 'finish_batch') {
        output = 'batch finished';
        finished = true;
      } else if (call.name === 'add_comment') {
        output = handleAddComment(rec, rule, changes.files, call.args, batchComments);
      } else {
        try {
          output = await executeTool(ctx, call.name, call.args);
        } catch (err) {
          output = `error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      // Small models can loop on the same tool call; nudge them via the tool
      // result before the batch drifts away entirely.
      if (
        lastCalls.some(
          (prev) =>
            prev.name === call.name && JSON.stringify(prev.args) === JSON.stringify(call.args),
        )
      ) {
        output +=
          '\n(hint: you already ran this exact tool call with the same arguments; use ' +
          'different arguments or call finish_batch to end the batch)';
      }
      const trace: ReviewTraceStep = {
        batchIndex: rec.job.batchIndex,
        step,
        tool: call.name,
        args: call.args,
        resultSummary: summarizeResult(output),
        durationMs: Date.now() - started,
      };
      rec.job.trace.push(trace);
      messages.push({ role: 'tool', content: output, toolCallId: call.id });
    }
    if (finished) return { comments: batchComments, endedAbruptly: false };
    // A model that repeats the same tool call(s) turn after turn is looping:
    // force-end the batch so it pauses and can be resumed from an earlier step.
    const sig = roundSignature(parsed.toolCalls);
    repeatRounds = sig === lastRoundSig ? repeatRounds + 1 : 0;
    lastRoundSig = sig;
    if (repeatRounds >= MAX_REPEAT_ROUNDS) return { comments: batchComments, endedAbruptly: true };
    lastCalls = parsed.toolCalls;
  }
}

/**
 * Validate an `add_comment` tool call, record it as a proposed comment, and
 * return the tool result text. Rejections and anchor adjustments return a hint
 * so the model can correct itself instead of the comment disappearing.
 */
function handleAddComment(
  rec: JobRecord,
  rule: ReviewRuleConfig,
  files: ReviewFile[],
  args: Record<string, unknown>,
  batchComments: ReviewComment[],
): string {
  if (rule.maxComments > 0 && rec.job.comments.length >= rule.maxComments) {
    return `comment limit reached (${rule.maxComments}); stop adding comments and call finish_batch`;
  }
  const { comment, hint } = commentFromTool(args, rule, files, '');
  if (!comment) return `comment rejected: ${hint ?? 'invalid arguments'}`;
  batchComments.push(comment);
  syncComments(rec, [comment], 'parsed');
  const anchor = comment.newLine !== null ? `:${comment.newLine}` : '';
  return hint
    ? `comment added for ${comment.filePath}${anchor} (${hint})`
    : `comment added for ${comment.filePath}${anchor}`;
}

/**
 * The context budget actually enforced: the configured estimate budget shrunk
 * by the calibration drift observed between real (usage-reported) prompt
 * tokens and the chars/3.5 estimate. Conservative accounting keeps the request
 * under the model's real window so a local server never truncates it.
 */
function effectiveBudget(rec: JobRecord): number {
  return Math.max(1024, Math.floor(rec.budget / rec.tokenDrift));
}

/** Word 3-grams over the trailing `REPEAT_WINDOW_CHARS` of `text`, normalized. */
function shingles(text: string): Set<string> {
  const sliced = text.length > REPEAT_WINDOW_CHARS ? text.slice(-REPEAT_WINDOW_CHARS) : text;
  const words = sliced
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= words.length; i++) {
    const a = words[i];
    const b = words[i + 1];
    const c = words[i + 2];
    if (a && b && c) grams.add(`${a} ${b} ${c}`);
  }
  return grams;
}

/** Whether `current` largely repeats the previous assistant turn. */
function looksRepeated(current: string, previous: string): boolean {
  const a = shingles(current);
  const b = shingles(previous);
  if (a.size === 0 || b.size === 0) return false;
  let hit = 0;
  for (const g of a) if (b.has(g)) hit++;
  return hit / Math.min(a.size, b.size) > REPEAT_OVERLAP;
}

/** An order-independent signature of a turn's tool calls (name + arguments). */
function roundSignature(calls: ToolCall[]): string {
  return calls
    .map((c) => `${c.name}\u0000${JSON.stringify(c.args)}`)
    .sort()
    .join('\u0001');
}

/**
 * The corrective user message pushed when the model ends a turn without an
 * explicit `finish_batch` tool call. A tool-free turn is treated as an abrupt
 * ending, so the model is told to keep reviewing or to finish explicitly.
 */
function nudgeMessage(repeated: boolean, commentCount: number): string {
  const prefix = repeated
    ? 'You are repeating yourself instead of reviewing. '
    : commentCount === 0
      ? 'You have not reported anything via add_comment in this batch. '
      : 'You ended this batch without calling finish_batch. ';
  return (
    prefix +
    'Either call add_comment now, once for each issue you can substantiate in the ' +
    'files listed above, or — if there is nothing more to report — call finish_batch ' +
    'to end this batch. Never write the review as prose.'
  );
}

function buildSystemPrompt(
  rule: ReviewRuleConfig,
  changes: ReviewChanges,
  batch: ReviewFile[],
  batchIndex: number,
  batchTotal: number,
): string {
  const batching = batchTotal > 1;
  const files = batch
    .map((f) => `- ${f.newPath}${f.newFile ? ' (new)' : ''}${f.deletedFile ? ' (deleted)' : ''}`)
    .join('\n');
  const diffs = batch
    .map((f) => `### ${f.newPath}\n${f.diff || '(binary or empty diff)'}`)
    .join('\n\n');
  const lines = [
    `You are reviewing a ${forgeLabel(changes.forge)}.`,
    rule.instructions,
    '',
    `${changes.forge === 'github' ? 'Pull request' : 'Merge request'} #${changes.mr.iid}: ${changes.mr.title}`,
    `Branches: ${changes.mr.sourceBranch} → ${changes.mr.targetBranch}`,
    '',
    // When the MR is split across batches, make the model's scope explicit: it is
    // reviewing a subset, and the other changed files belong to other batches.
    ...(batching
      ? [
          `This is batch ${batchIndex} of ${batchTotal} of this merge request; only the ` +
            'files listed below are under review here. The remaining changed files are ' +
            'covered by the other batches — do not search for them, read their diffs, ' +
            'or comment on them.',
          '',
        ]
      : []),
    batching ? 'Changed files in this batch:' : 'Changed files:',
    files,
    '',
    'Diff:',
    diffs,
    '',
    // A comment must be substantiated by the repository at the MR head, including
    // code the diff does not show.
    'Before writing a comment, verify the fact against the repository at the ' +
      'merge request head — read the file and search related code, including files ' +
      'that are not part of the diff (callers, interfaces, tests, config). Only ' +
      'report an issue you can substantiate with a concrete file and line; if the ' +
      'code already handles the case, do not comment.',
    ...(batching
      ? [
          '',
          'Reading unchanged repository files to confirm a finding is fine, but a ' +
            'changed file handled by another batch is out of scope: do not inspect or ' +
            'comment on a changed file that is not listed above.',
        ]
      : []),
    '',
    'Report every issue by calling add_comment as soon as you can substantiate it — ' +
      'never wait until the end, and never write comments in a final message. Use the ' +
      'provided tools to read the rest of the repository at the MR head before ' +
      'commenting. Give a line that is present in the diff, or omit the anchor for a ' +
      'comment about the file as a whole rather than guessing a line.',
    '',
    'When you have covered the diff and have nothing further to report or inspect, ' +
      'call finish_batch to end this batch. Never write the review as a final message.',
  ];
  return lines.join('\n');
}

/** Native `tools` payload sent to OpenAI-compatible endpoints. */
function nativeTools(): unknown[] {
  return TOOLS.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/** Serialize a chat message in OpenAI wire format (native tool calls only). */
function toWire(): (m: ChatMessage) => Record<string, unknown> {
  return (m) => {
    if (m.role === 'tool') {
      return { role: 'tool', content: m.content, tool_call_id: m.toolCallId ?? '' };
    }
    if (m.role === 'assistant' && m.toolCalls) {
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

/**
 * Keep the conversation inside the context budget, best-effort. The batch diff
 * lives in the system prompt and cannot shrink, so one pass may not reach the
 * budget; escalate in bounded passes: condense old tool results, then old
 * assistant prose, then drop the details of the oldest tool results entirely.
 * Assistant `tool_calls` arrays are never rewritten, so every tool result keeps
 * its pairing on the wire (no message is ever removed); the system message, the
 * first user message, and the last few turns stay verbatim.
 */
function pruneMessages(messages: ChatMessage[], budget: number): void {
  const protect = 4;
  if (messagesTokens(messages) <= budget) return;
  for (let i = 1; i < messages.length - protect; i++) {
    const m = messages[i];
    if (m && m.role === 'tool' && m.content.length > 200) {
      m.content = `(earlier observation, condensed) ${summarizeResult(m.content)}`;
    }
  }
  if (messagesTokens(messages) <= budget) return;
  for (let i = 1; i < messages.length - protect; i++) {
    const m = messages[i];
    if (m && m.role === 'assistant' && m.content.length > 200) {
      m.content = `(earlier assistant message, condensed) ${summarizeResult(m.content)}`;
    }
  }
  if (messagesTokens(messages) <= budget) return;
  for (let i = 1; i < messages.length - protect; i++) {
    const m = messages[i];
    if (m && m.role === 'tool' && m.content.length > 80) {
      m.content = '(earlier tool result omitted)';
    }
  }
}
