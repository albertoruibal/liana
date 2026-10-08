// Persistent code-review sessions: the checkpoint state that lets a review be
// paused, survive a server/Electron restart, and be resumed. Node-only: imported
// by src/review.ts and src/api.ts, never by the browser bundle.
//
// Sessions hold review content (diffs, agent conversation, proposed comments) —
// not secrets — and live under `~/.config/liana/sessions/`. The directory is
// 0700 and every file is written atomically with mode 0600, mirroring the
// settings store. Ids are opaque and keyed by absolute repository path so they
// survive the per-process repo-id reassignment.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatMessage } from './review-tools';
import type { ForgeKind, ReviewChanges, ReviewJob, ReviewRuleConfig } from './types';

/** In-flight agent checkpoint inside the current batch, sufficient to resume. */
export interface BatchCheckpoint {
  /** Zero-based index into `batches`. */
  batchIndex: number;
  messages: ChatMessage[];
  step: number;
}

/** The full on-disk shape of a review session (server-only; never sent as-is). */
export interface StoredReviewSession {
  id: string;
  repoPath: string;
  createdAt: number;
  updatedAt: number;
  changes: ReviewChanges;
  rule: ReviewRuleConfig;
  providerId: string | null;
  maxSteps: number;
  budget: number;
  /** Changed-file indices grouped into batches, preserving order. */
  batches: number[][];
  /** Zero-based batch currently being (or next to be) processed. */
  batchIndex: number;
  checkpoint: BatchCheckpoint | null;
  job: ReviewJob;
}

const ID_RE = /^[A-Za-z0-9_-]+$/;
const MAX_SESSIONS_PER_REPO = 12;

/** Location of the sessions directory (`XDG_CONFIG_HOME` aware). */
export function sessionsDir(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config');
  return path.join(base, 'liana', 'sessions');
}

function sessionFile(id: string): string | null {
  return ID_RE.test(id) ? path.join(sessionsDir(), `${id}.json`) : null;
}

/** Read and validate one session, or null when absent/corrupt. */
export function readSession(id: string): StoredReviewSession | null {
  const file = sessionFile(id);
  if (!file) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return coerceSession(raw);
  } catch {
    return null;
  }
}

/** Atomically persist a session (tmp + rename, mode 0600). */
export function writeSession(s: StoredReviewSession): void {
  const file = sessionFile(s.id);
  if (!file) return;
  const dir = sessionsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  pruneSessions(s.repoPath);
}

/** Remove a session file. Returns true when a file was deleted. */
export function deleteSession(id: string): boolean {
  const file = sessionFile(id);
  if (!file) return false;
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/** Every stored session for a repository, newest first. */
export function listSessions(repoPath: string): StoredReviewSession[] {
  const dir = sessionsDir();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: StoredReviewSession[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const s = readSession(name.slice(0, -'.json'.length));
    if (s && s.repoPath === repoPath) out.push(s);
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

/** Keep only the newest `MAX_SESSIONS_PER_REPO` sessions for a repository. */
export function pruneSessions(repoPath: string): void {
  for (const stale of listSessions(repoPath).slice(MAX_SESSIONS_PER_REPO)) deleteSession(stale.id);
}

/**
 * Mark sessions left `running` by a previous process as `paused` so they can be
 * resumed instead of appearing to hang forever. Called once at API creation.
 */
export function markInterruptedSessions(): void {
  const dir = sessionsDir();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const s = readSession(name.slice(0, -'.json'.length));
    if (!s || s.job.state !== 'running') continue;
    s.job.state = 'paused';
    s.job.error = null;
    s.updatedAt = Date.now();
    try {
      writeSession(s);
    } catch {
      // A read-only config dir must not break startup.
    }
  }
}

// --- tolerant parsing (the file may be hand-edited) ---

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function optionalString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function coerceChanges(v: unknown): ReviewChanges | null {
  if (!isRecord(v) || !isRecord(v.mr) || !Array.isArray(v.files) || !isRecord(v.diffRefs)) {
    return null;
  }
  const mr = v.mr;
  const refs = v.diffRefs;
  // Sessions written before the forge field existed are GitLab-only.
  const forge: ForgeKind = v.forge === 'github' ? 'github' : 'gitlab';
  return {
    forge,
    mr: {
      iid: Math.floor(num(mr.iid, 0)),
      title: str(mr.title, ''),
      author: str(mr.author, ''),
      sourceBranch: str(mr.sourceBranch, ''),
      targetBranch: str(mr.targetBranch, ''),
      state: str(mr.state, ''),
      webUrl: str(mr.webUrl, ''),
      updatedAt: str(mr.updatedAt, ''),
      draft: mr.draft === true,
    },
    files: v.files.filter(isRecord).map((f) => ({
      oldPath: str(f.oldPath, ''),
      newPath: str(f.newPath, ''),
      newFile: f.newFile === true,
      deletedFile: f.deletedFile === true,
      renamedFile: f.renamedFile === true,
      diff: str(f.diff, ''),
    })),
    diffRefs: {
      baseSha: str(refs.baseSha, ''),
      headSha: str(refs.headSha, ''),
      startSha: str(refs.startSha, ''),
    },
  };
}

function coerceRule(v: unknown): ReviewRuleConfig {
  const r = isRecord(v) ? v : {};
  const sev = r.severityThreshold;
  return {
    instructions: str(r.instructions, ''),
    severityThreshold:
      sev === 'warning' || sev === 'error' || sev === 'info' ? sev : 'info',
    ignoreGlobs: Array.isArray(r.ignoreGlobs)
      ? r.ignoreGlobs.filter((g): g is string => typeof g === 'string')
      : [],
    maxComments: Math.max(0, Math.floor(num(r.maxComments, 0))),
    language: str(r.language, 'English'),
    maxSteps: Math.max(1, Math.floor(num(r.maxSteps, 8))),
    batchByFile: r.batchByFile !== false,
  };
}

function coerceJob(v: unknown): ReviewJob | null {
  if (!isRecord(v)) return null;
  const state = v.state;
  if (
    state !== 'running' &&
    state !== 'paused' &&
    state !== 'done' &&
    state !== 'error' &&
    state !== 'cancelled'
  ) {
    return null;
  }
  return {
    id: str(v.id, ''),
    state,
    batchIndex: Math.max(0, Math.floor(num(v.batchIndex, 0))),
    batchTotal: Math.max(1, Math.floor(num(v.batchTotal, 1))),
    output: str(v.output, ''),
    trace: Array.isArray(v.trace)
      ? v.trace.filter(isRecord).map((t) => ({
          step: Math.floor(num(t.step, 0)),
          tool: str(t.tool, ''),
          args: isRecord(t.args) ? t.args : {},
          resultSummary: str(t.resultSummary, ''),
          durationMs: Math.max(0, Math.floor(num(t.durationMs, 0))),
        }))
      : [],
    prompts: Array.isArray(v.prompts)
      ? v.prompts.filter(isRecord).map((p) => ({
          step: Math.floor(num(p.step, 0)),
          text: str(p.text, ''),
          chars: Math.max(0, Math.floor(num(p.chars, 0))),
          truncated: p.truncated === true,
        }))
      : [],
    memories: Array.isArray(v.memories)
      ? v.memories
          .filter(isRecord)
          .map((m) => ({ id: str(m.id, ''), note: str(m.note, '') }))
          .filter((m) => m.note.length > 0)
      : [],
    comments: Array.isArray(v.comments)
      ? v.comments.filter(isRecord).map((c) => ({
          id: str(c.id, ''),
          filePath: str(c.filePath, ''),
          oldLine: typeof c.oldLine === 'number' ? c.oldLine : null,
          newLine: typeof c.newLine === 'number' ? c.newLine : null,
          severity: c.severity === 'error' || c.severity === 'warning' ? c.severity : 'info',
          body: str(c.body, ''),
          status:
            c.status === 'approved' ||
            c.status === 'rejected' ||
            c.status === 'posted' ||
            c.status === 'failed'
              ? c.status
              : 'pending',
          stage: c.stage === 'parsed' ? 'parsed' : 'pending',
          discussionId: optionalString(c.discussionId),
          error: optionalString(c.error),
        }))
      : [],
    error: optionalString(v.error),
  };
}

function coerceCheckpoint(v: unknown): BatchCheckpoint | null {
  if (!isRecord(v) || !Array.isArray(v.messages)) return null;
  const messages: ChatMessage[] = [];
  for (const m of v.messages) {
    if (!isRecord(m)) continue;
    const role = m.role;
    if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') continue;
    const msg: ChatMessage = { role, content: str(m.content, '') };
    if (typeof m.toolCallId === 'string') msg.toolCallId = m.toolCallId;
    if (Array.isArray(m.toolCalls)) {
      msg.toolCalls = m.toolCalls.filter(isRecord).map((c) => ({
        id: str(c.id, ''),
        name: str(c.name, ''),
        args: isRecord(c.args) ? c.args : {},
      }));
    }
    messages.push(msg);
  }
  return {
    batchIndex: Math.max(0, Math.floor(num(v.batchIndex, 0))),
    messages,
    step: Math.max(0, Math.floor(num(v.step, 0))),
  };
}

function coerceSession(raw: unknown): StoredReviewSession | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id, '');
  const repoPath = str(raw.repoPath, '');
  const changes = coerceChanges(raw.changes);
  const job = coerceJob(raw.job);
  if (!id || !repoPath || !changes || !job) return null;
  const batches = Array.isArray(raw.batches)
    ? raw.batches.map((b: unknown) =>
        Array.isArray(b) ? b.map((i) => Math.floor(num(i, -1))).filter((i) => i >= 0) : [],
      )
    : [];
  return {
    id,
    repoPath,
    createdAt: num(raw.createdAt, Date.now()),
    updatedAt: num(raw.updatedAt, Date.now()),
    changes,
    rule: coerceRule(raw.rule),
    providerId: optionalString(raw.providerId),
    maxSteps: Math.max(1, Math.floor(num(raw.maxSteps, 8))),
    budget: Math.max(1024, Math.floor(num(raw.budget, 4096))),
    batches,
    batchIndex: Math.max(0, Math.floor(num(raw.batchIndex, 0))),
    checkpoint: coerceCheckpoint(raw.checkpoint),
    job,
  };
}
