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
    void runReview(live).catch((err: unknown) => finishWithError(live, err));
    return leanJob(structuredClone(live.job));
  }
  const s = readSession(id);
  if (!s || s.repoPath !== repoPath || (s.job.state !== 'paused' && s.job.state !== 'error')) return null;
  const rec = recordFromStored(s);
  rec.job.state = 'running';
  rec.job.error = null;
  jobs.set(id, rec);
  void runReview(rec).catch((err: unknown) => finishWithError(rec, err));
  return leanJob(structuredClone(rec.job));
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

/** Set up the batch plan on the first run. */
function planReview(rec: JobRecord): StoredProvider {
  const provider = requireProvider(rec.providerId);
  rec.providerId = provider.id;
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
  return provider;
}

async function runReview(rec: JobRecord): Promise<void> {
  const provider = planReview(rec);
  const budget = rec.budget;

  for (let i = rec.job.batchIndex > 0 ? rec.job.batchIndex - 1 : 0; i < rec.batches.length; i++) {
    if (rec.cancelled || rec.paused) return;
    const indices = rec.batches[i] ?? [];
    rec.job.batchIndex = i + 1;
    rec.job.batchStep = 0;

    const batchComments = await runBatch(rec, provider, budget, indices);
    rec.checkpoint = null;
    syncComments(rec, batchComments, 'parsed');
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
 * from the endpoint is preferred; when it is absent fall back to the chars/4
 * estimate and flag it as such.
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
  } else {
    entry.promptTokens = messagesTokens(messages);
    entry.completionTokens = estimateTokens(result.content);
    entry.usageEstimated = true;
  }
}

async function runBatch(
  rec: JobRecord,
  provider: StoredProvider,
  budget: number,
  indices: number[],
): Promise<ReviewComment[]> {
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
    files: changes.files,
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
        'only comment on the files listed above. When you are done, reply with no tool calls.',
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

  for (;;) {
    if (rec.cancelled || rec.paused) return [];
    step++;
    rec.job.batchStep = step;
    pruneMessages(messages, budget);
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
      max_tokens: provider.maxTokens,
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

    // The model self-terminates: a turn with no tool calls means it is done.
    if (parsed.toolCalls.length === 0) {
      return batchComments;
    }

    messages.push({ role: 'assistant', content: parsed.content, toolCalls: parsed.toolCalls });
    for (const call of parsed.toolCalls) {
      if (rec.cancelled || rec.paused) return [];
      const started = Date.now();
      let output: string;
      if (call.name === 'add_comment') {
        output = handleAddComment(rec, rule, changes.files, call.args, batchComments);
      } else {
        try {
          output = await executeTool(ctx, call.name, call.args);
        } catch (err) {
          output = `error: ${err instanceof Error ? err.message : String(err)}`;
        }
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
    return `comment limit reached (${rule.maxComments}); stop adding comments and reply with no tool calls`;
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
      'reply with no tool calls.',
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
