// Code review main view: one tab per repository, MR/session state, jobs, and comments.

import { reviewApi } from './api-client';
import { refresh } from './actions';
import { confirmDialog } from './confirm';
import { loadCode } from './code-loader';
import { readDiffView, writeDiffView } from './diff-view';
import { esc, gutter } from './format';
import { renderCached } from './graph-view';
import { ReviewTabState, activeReviewState, activeTab, isReviewShown, store } from './store';
import { activateCompareTab, activateReviewTab, renderTabs } from './tabs';
import { toast } from './toast';
import { $ } from './dom';
import { CodeHandle } from '../code';
import { DiffLine, parsePatch } from '../diff';
import { ForgeKind, ReviewChanges, ReviewComment, ReviewCommentStatus, ReviewFile, ReviewJob, ReviewOutputSegment, ReviewPromptStep, ReviewRequest, ReviewSession, ReviewSessionView } from '../types';
import { invalidateAiConflict } from './ai-conflict';
import { closeContextMenu, contextMenu } from './context-menu';
import { closeMoreMenu, moreMenu } from './more-menu';
import { closeSearch } from './search';
import { closeStatusHistory, statusHistory } from './status-bar';
import { initReviewFileResizer, jumpReviewDiff, layoutReviewDiff, renderReviewChanges, renderReviewFileDiff, selectReviewFile } from './review-changes';
import { applyPanel } from './terminal-view';

/** The review tab currently shown, if any. */
export function activeReview(): ReviewTabState | null {
  return activeReviewState();
}

export const REVIEW_TABS_KEY = 'liana-review-tabs';

export const REVIEW_COMPARE_TABS_KEY = 'liana-compare-tabs';

export const REVIEW_ACTIVE_KEY = 'liana-review-active';

/** Short/long noun for a review tab's forge; defaults to GitLab for old sessions. */
export function forgeLabels(forge: ForgeKind | undefined): { short: string; long: string; prefix: string } {
  return forge === 'github'
    ? { short: 'PR', long: 'pull request', prefix: '#' }
    : { short: 'MR', long: 'merge request', prefix: '!' };
}

/** Format a request number using the forge's convention (`!123` vs `#123`). */
export function requestNumber(forge: ForgeKind | undefined, iid: number): string {
  return `${forgeLabels(forge).prefix}${iid}`;
}

/** The review subtitle shown on its tab tooltip: the selected request, or a hint. */
export function reviewTabSubtitle(state: ReviewTabState | undefined): string {
  const changes = state?.changes;
  if (!changes) {
    return state?.mode === 'compare'
      ? 'Compare two local branches with AI.'
      : 'Review an open merge/pull request or a single commit with AI.';
  }
  if (changes.commit) {
    return `Commit ${changes.commit.shortHash}: ${changes.commit.subject} — ${changes.files.length} file(s)`;
  }
  const compare = changes.compare;
  if (compare) {
    const sep = compare.mode === 'merge-base' ? '...' : '..';
    return `Compare ${compare.baseRef}${sep}${compare.headRef} — ${changes.files.length} file(s)`;
  }
  return `${requestNumber(changes.forge, changes.mr.iid)}: ${changes.mr.title} — ${changes.files.length} file(s)`;
}

/** Update the review toolbar wording (request vs comparison) for a tab. */
export function paintForgeWording(state: ReviewTabState): void {
  if (!isReviewShown(state)) return;
  const commit = state.changes?.commit;
  const compareMode = state.mode === 'compare';
  const select = $<HTMLSelectElement>('#review-mr-select');
  const { short, long } = forgeLabels(state.changes?.forge);
  $('#review-mr-toolbar').hidden = compareMode;
  $('#review-compare-bar').hidden = !compareMode;
  if (compareMode) {
    $('#review-mr-label').textContent = 'Branch comparison';
    $('#review-generate').textContent = 'Review comparison with AI';
    $('#review-checkout-mr').hidden = true;
    $('#review-approve-mr').hidden = true;
    select.disabled = true;
    select.title = '';
    return;
  }
  if (commit) {
    $('#review-mr-label').textContent = 'Commit';
    $('#review-refresh-mrs').hidden = true;
    $('#review-checkout-mr').hidden = true;
    $('#review-approve-mr').hidden = true;
    select.disabled = true;
    select.title = 'Single-commit reviews keep their proposed comments local.';
    $('#review-generate').textContent = 'Review with AI';
    return;
  }
  $('#review-mr-label').textContent = long.charAt(0).toUpperCase() + long.slice(1);
  $('#review-approve-mr').textContent = `Approve ${short}`;
  $('#review-refresh-mrs').hidden = false;
  $('#review-checkout-mr').hidden = false;
  select.disabled = false;
  select.title = '';
  $('#review-generate').textContent = 'Review with AI';
  $<HTMLButtonElement>('#review-checkout-mr').disabled = state.changes === null;
}

/** Legacy head-missing note from sessions written before reviews refused to run. */
function jobHeadWarning(job: ReviewJob | null): string | null {
  const note = job?.trace.find((t) => t.tool === 'repo_tools');
  return note ? note.resultSummary : null;
}

/** Show or hide the warning banner for a review tab (head fetch or step cap). */
export function paintReviewWarning(state: ReviewTabState): void {
  if (!isReviewShown(state)) return;
  const el = $('#review-warning');
  const message = state.headWarning ?? jobHeadWarning(state.job);
  el.hidden = message === null;
  el.textContent = message ?? '';
}

/** Styled confirmation before publishing a forge approval. */
export function confirmApprove(state: ReviewTabState): Promise<boolean> {
  const changes = state.changes;
  if (!changes) return Promise.resolve(false);
  const { long } = forgeLabels(changes.forge);
  $('#approve-title').textContent = `Approve ${long}?`;
  $('#approve-summary').textContent =
    `${requestNumber(changes.forge, changes.mr.iid)} ${changes.mr.title} — ` +
    `this publishes an approval on the ${long}.`;
  const dlg = $<HTMLDialogElement>('#approve-dialog');
  return new Promise((resolve) => {
    const confirmBtn = $<HTMLButtonElement>('#approve-confirm');
    const cancelBtn = $<HTMLButtonElement>('#approve-cancel');
    const onConfirm = (): void => {
      cleanup();
      dlg.close();
      resolve(true);
    };
    const onCancel = (): void => {
      cleanup();
      dlg.close();
      resolve(false);
    };
    const cleanup = (): void => {
      confirmBtn.removeEventListener('click', onConfirm);
      cancelBtn.removeEventListener('click', onCancel);
      dlg.removeEventListener('cancel', onCancel);
    };
    confirmBtn.addEventListener('click', onConfirm);
    cancelBtn.addEventListener('click', onCancel);
    dlg.addEventListener('cancel', onCancel);
    dlg.showModal();
  });
}

/** Remember the open review/compare tabs (by path) and which one was visible. */
export function persistReviewTabs(): void {
  try {
    const review = store.tabs.filter((t) => t.review).map((t) => t.path);
    const compare = store.tabs.filter((t) => t.compare).map((t) => t.path);
    localStorage.setItem(REVIEW_TABS_KEY, JSON.stringify(review));
    localStorage.setItem(REVIEW_COMPARE_TABS_KEY, JSON.stringify(compare));
    const active = activeReview();
    if (active) {
      localStorage.setItem(
        REVIEW_ACTIVE_KEY,
        JSON.stringify({ path: active.repoPath, mode: active.mode }),
      );
    } else {
      localStorage.removeItem(REVIEW_ACTIVE_KEY);
    }
  } catch {
    // localStorage may be unavailable (private mode); review still works in-session.
  }
}

export function readSavedReviewPaths(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(REVIEW_TABS_KEY) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

export function readSavedComparePaths(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(REVIEW_COMPARE_TABS_KEY) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

/** Restore the last visible review panel, migrating the old path-only value. */
export function readSavedReviewActive(): { path: string; mode: 'request' | 'compare' } | null {
  try {
    const raw = localStorage.getItem(REVIEW_ACTIVE_KEY);
    if (!raw) return null;
    if (raw.startsWith('{')) {
      const parsed = JSON.parse(raw) as { path?: unknown; mode?: unknown };
      if (typeof parsed.path === 'string') {
        return { path: parsed.path, mode: parsed.mode === 'compare' ? 'compare' : 'request' };
      }
      return null;
    }
    return { path: raw, mode: 'request' };
  } catch {
    return null;
  }
}

/** Best-effort flush of comment edits for every review/compare tab when the page goes away. */
export function flushReviewEdits(): void {
  for (const tab of store.tabs) {
    for (const state of [tab.review, tab.compare]) {
      if (!state?.job) continue;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-liana-repo': state.repoId,
      };
      const token = window.liana?.token;
      if (token) headers['x-liana-token'] = token;
      fetch('/api/review/session/save', {
        method: 'POST',
        headers,
        body: JSON.stringify({ sessionId: state.job.id, comments: state.job.comments }),
        keepalive: true,
      }).catch(() => {
        // The page is unloading; nothing to recover here.
      });
    }
  }
}

export function refreshSessionSelect(state: ReviewTabState): void {
  const sel = $<HTMLSelectElement>('#review-session-select');
  const current = state.job?.id ?? '';
  const relevant = state.sessions.filter((s) =>
    state.mode === 'compare' ? !!(s.compare || s.commit) : !s.compare && !s.commit,
  );
  sel.innerHTML =
    '<option value="">— Saved reviews —</option>' +
    relevant
      .map((s) => {
        const label = s.compare
          ? `Compare ${esc(s.compare)}`
          : s.commit
            ? `Commit ${esc(s.commit)} ${esc(s.title)}`
            : `${requestNumber(s.forge, s.iid)} ${esc(s.title)}`;
        return (
          `<option value="${esc(s.id)}"${s.id === current ? ' selected' : ''}>` +
          `${label} — ${esc(s.state)}${s.commentCount > 0 ? ` (${s.commentCount})` : ''}${s.llmDurationMs > 0 ? ` · ${fmtDuration(s.llmDurationMs)}` : ''}</option>`
        );
      })
      .join('');
  $<HTMLButtonElement>('#review-delete-session').toggleAttribute('disabled', !current);
}

export async function loadReviewSessions(state: ReviewTabState): Promise<void> {
  try {
    const { sessions } = await reviewApi<{ sessions: ReviewSession[] }>(state, '/review/sessions');
    state.sessions = sessions;
    if (isReviewShown(state)) refreshSessionSelect(state);
  } catch {
    // A failed listing leaves the previous picker contents in place.
  }
}

/** Add a just-started review to the picker before the server listing refreshes. */
function rememberStartedSession(state: ReviewTabState, job: ReviewJob): void {
  const changes = state.changes;
  if (!changes) return;
  const entry: ReviewSession = {
    id: job.id,
    iid: changes.mr.iid,
    title: changes.mr.title,
    state: job.state,
    updatedAt: Date.now(),
    providerId: null,
    commentCount: job.comments.length,
    batchIndex: job.batchIndex,
    batchTotal: job.batchTotal,
    llmDurationMs: job.llmDurationMs,
    forge: changes.forge,
    commit: changes.commit?.shortHash ?? null,
    compare: changes.compare
      ? `${changes.compare.baseRef}${changes.compare.mode === 'merge-base' ? '...' : '..'}${changes.compare.headRef}`
      : null,
  };
  state.sessions = [entry, ...state.sessions.filter((s) => s.id !== entry.id)];
  if (isReviewShown(state)) refreshSessionSelect(state);
}

/** Restore a persisted session (or a live paused job) into the review view. */
export async function restoreSession(state: ReviewTabState, sessionId: string): Promise<void> {
  if (!sessionId) return;
  const status = $('#review-status');
  if (isReviewShown(state)) status.textContent = 'Restoring review…';
  window.clearTimeout(state.poll);
  try {
    const view = await reviewApi<ReviewSessionView>(state, '/review/session', { sessionId });
    applySessionView(state, view);
    if (view.job.state === 'running') {
      state.poll = window.setTimeout(() => void pollJob(state), 600);
    }
    if (isReviewShown(state)) refreshSessionSelect(state);
  } catch (err) {
    if (isReviewShown(state)) status.textContent = String(err);
  }
}

/** Push a loaded session into the review view's state and DOM. */
export function applySessionView(state: ReviewTabState, view: ReviewSessionView): void {
  state.changes = view.changes;
  state.job = view.job;
  const compare = view.changes.compare;
  const commit = view.changes.commit;
  state.mode = compare || commit ? 'compare' : 'request';
  if (compare) {
    state.compareBase = compare.baseRef;
    state.compareHead = compare.headRef;
  } else if (commit) {
    state.compareBase = commit.baseHash ?? '';
    state.compareHead = commit.hash;
  }
  state.selectedFile = null;
  // Keep the MR picker in step with the session it belongs to, even when the
  // request is no longer open (refreshMrSelect renders it as an extra option).
  state.mrIid = view.changes.mr.iid;
  state.edits.clear();
  state.showRejected = false;
  state.headWarning = null;
  for (const c of view.job.comments) {
    state.edits.set(c.id, { body: c.body, status: c.status });
  }
  renderTabs();
  if (!isReviewShown(state)) return;
  paintForgeWording(state);
  refreshMrSelect(state);
  paintCompareForm(state);
  renderReviewChanges(state);
  $('#review-approve-mr').hidden = !!view.changes.commit || !!view.changes.compare;
  renderJob(state, view.job);
  if (view.job.comments.length === 0) $('#review-queue-wrap').hidden = true;
  paintReviewPane(state);
}

export function refreshMrSelect(state: ReviewTabState): void {
  const sel = $<HTMLSelectElement>('#review-mr-select');
  const commit = state.changes?.commit;
  if (commit) {
    sel.innerHTML = `<option value="0">${esc(commit.shortHash)} — ${esc(commit.subject)}</option>`;
    sel.value = '0';
    sel.disabled = true;
    $('#review-generate').hidden = true;
    return;
  }
  if (state.mode === 'compare' || state.changes?.compare) {
    sel.innerHTML = '<option value="0">Branch comparison</option>';
    sel.value = '0';
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  const { long } = forgeLabels(state.changes?.forge);
  const listed = state.mrs.some((m) => m.iid === state.mrIid);
  // A session may target a request that is no longer open (closed/merged);
  // pin it as an extra option so the picker still reflects the restored MR.
  const pinned =
    state.mrIid > 0 && !listed && state.changes ? state.changes.mr : undefined;
  sel.innerHTML =
    `<option value="">— Select ${long} —</option>` +
    (pinned
      ? `<option value="${pinned.iid}">${requestNumber(state.changes?.forge, pinned.iid)} ${esc(pinned.title)} — (not open)</option>`
      : '') +
    state.mrs
      .map(
        (m) =>
          `<option value="${m.iid}">${requestNumber(state.changes?.forge, m.iid)} ${esc(m.draft ? 'Draft: ' : '')}${esc(m.title)} — ${esc(m.sourceBranch)}→${esc(m.targetBranch)}</option>`,
      )
      .join('');
  // Restore this tab's selection when it exists (listed or pinned), else the placeholder.
  if (state.mrIid > 0 && (listed || pinned)) {
    sel.value = String(state.mrIid);
  } else {
    state.mrIid = 0;
    sel.value = '';
  }
  $<HTMLButtonElement>('#review-generate').toggleAttribute(
    'disabled',
    state.mrs.length === 0 || state.mrIid === 0,
  );
}

export async function loadMergeRequests(state: ReviewTabState): Promise<void> {
  const status = $('#review-status');
  // Never clobber a restored session's status (e.g. "paused") with MR-list noise.
  if (isReviewShown(state) && !state.job) status.textContent = 'Loading requests…';
  try {
    const { mrs } = await reviewApi<{ mrs: ReviewRequest[] }>(state, '/forge/mrs');
    state.mrs = mrs;
    if (!isReviewShown(state)) return;
    refreshMrSelect(state);
    if (!state.job) status.textContent = mrs.length === 0 ? 'No open requests.' : '';
  } catch (err) {
    if (!isReviewShown(state)) return;
    if (!state.job) status.textContent = String(err);
  }
}

/** Fetch the selected MR's changes; returns false when there is no selection. */
export async function loadSelectedMr(fetchRefs = false): Promise<boolean> {
  const state = activeReview();
  if (!state) return false;
  const status = $('#review-status');
  const iid = Number($<HTMLSelectElement>('#review-mr-select').value);
  state.mrIid = iid;
  if (!iid) return false;
  status.textContent = fetchRefs ? 'Loading changes and request commit…' : 'Loading changes…';
  try {
    const { changes, fetch: fetchResult } = await reviewApi<{
      changes: ReviewChanges;
      fetch?: { fetched: boolean; error?: string };
    }>(state, '/forge/mr', fetchRefs ? { iid, fetch: true } : { iid });
    state.changes = changes;
    state.mode = 'request';
    state.selectedFile = null;
    state.job = null;
    state.edits.clear();
    state.showRejected = false;
    renderTabs();
    // A tab switch landed while this was in flight — the state is updated but
    // the DOM belongs to another review now.
    if (!isReviewShown(state)) return true;
    refreshMrSelect(state);
    refreshSessionSelect(state);
    paintForgeWording(state);
    renderReviewChanges(state);
    paintReviewPane(state);
    $('#review-queue-wrap').hidden = true;
    paintJobControls(state, null);
    $('#review-approve-mr').hidden = false;
    // A failed head fetch silently degrades the AI review to diff-only, so keep
    // it visible: the warning offers to check out the request branch instead.
    state.headWarning = fetchResult?.error
      ? `The request commit could not be fetched (${fetchResult.error}); the AI review would run against the diff only.`
      : null;
    status.textContent = '';
    paintReviewWarning(state);
    return true;
  } catch (err) {
    status.textContent = String(err);
    return false;
  }
}

// Signature of the last model-log render, so a poll tick only rebuilds the
// timeline (and doesn't reset the user's scroll while streaming). It covers the
// model calls' metadata and every tool call, but not the streamed response
// segments, which the user reads live through the open Response pane.
let logTimelineSig = '';

// Model-log on-demand state: the polled job carries only step metadata, so each
// step's full prompt/response is fetched lazily from /review/log when expanded.
// Each call exposes independent Prompt and Response toggles, tracked per part.
let logJobId: string | null = null;
let logRenderState: ReviewTabState | null = null;
/** Full step for completed calls only; the in-flight call is never cached. */
const logStepCache = new Map<number, ReviewPromptStep>();
/** Immutable prompt text, fetched once even for the in-flight call. */
const logTextCache = new Map<number, string>();
const logOpenParts = new Set<string>();
const logOpenBatches = new Set<number>();
const logLoadingSteps = new Set<number>();

/** Drop the model log's per-step caches after a resume rewrites the step arrays. */
function resetReviewLogCaches(): void {
  logJobId = null;
  logTimelineSig = '';
  logStepCache.clear();
  logTextCache.clear();
  logOpenParts.clear();
  logOpenBatches.clear();
  logLoadingSteps.clear();
}

/** Compact duration: `820ms`, `4.2s`, `1m03s`, `3h32m02s`. */
function fmtDuration(ms: number): string {
  if (ms <= 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const total = Math.floor(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}h${pad(m)}m${pad(sec)}s` : `${m}m${pad(sec)}s`;
}

/** Thousands-separated count, with a `~` prefix when the value is estimated. */
function fmtCount(n: number | null, estimated: boolean): string | null {
  if (n === null) return null;
  return `${estimated ? '~' : ''}${n.toLocaleString('en-US')}`;
}

/** `820 tok/s`, or '' when there is no measurable rate. */
function fmtRate(completionTokens: number | null, durationMs: number): string {
  if (completionTokens === null || durationMs < 250) return '';
  return `${Math.round(completionTokens / (durationMs / 1000)).toLocaleString('en-US')} tok/s`;
}

/** A small pill used for the call head and trace headers. */
function chip(text: string, cls = ''): string {
  return `<span class="review-log-chip${cls ? ` ${cls}` : ''}">${esc(text)}</span>`;
}

/** Structured header for a logged model call: a step badge plus metric chips. */
function callHeaderHtml(p: ReviewPromptStep, idx: number, disabled: boolean): string {
  const chips: string[] = [];
  const prompt = fmtCount(p.promptTokens, p.usageEstimated);
  if (prompt !== null) chips.push(chip(`↑ ${prompt} in`));
  const completion = fmtCount(p.completionTokens, p.usageEstimated);
  if (completion !== null) chips.push(chip(`↓ ${completion} out`));
  chips.push(chip(fmtDuration(p.durationMs)));
  const rate = fmtRate(p.completionTokens, p.durationMs);
  if (rate) chips.push(chip(rate));
  chips.push(chip(`${p.chars.toLocaleString('en-US')} chars`, 'is-dim'));
  if (p.truncated) chips.push(chip('truncated', 'is-warn'));
  return (
    `<div class="review-log-call-head">` +
    `<span class="review-log-badge">Step ${p.step}</span>` +
    `<span class="review-log-metrics">${chips.join('')}</span>` +
    `<button type="button" class="btn review-log-resume-step" data-idx="${idx}"` +
    (disabled ? ' disabled' : '') +
    ` title="${
      disabled
        ? 'Pause the review before resuming from a step'
        : 'Re-run this batch from this step; the later steps in the batch are discarded'
    }">` +
    `Resume from here</button>` +
    `</div>`
  );
}

/** A one-line, human-readable description of a tool call and its key arguments. */
function toolSummary(tool: string, args: Record<string, unknown>): string {
  const str = (k: string): string | null => {
    const v = args[k];
    return typeof v === 'string' && v.length > 0 ? v : null;
  };
  const num = (k: string): number | null => {
    const v = args[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  switch (tool) {
    case 'read_file': {
      const path = str('path');
      if (!path) return '';
      const start = num('startLine');
      const end = num('endLine');
      if (start !== null && end !== null) return `${path}:${start}-${end}`;
      if (start !== null) return `${path}:${start}`;
      return path;
    }
    case 'search_code': {
      const pattern = str('pattern');
      if (!pattern) return '';
      const glob = str('glob');
      return glob ? `"${pattern}" in ${glob}` : `"${pattern}"`;
    }
    case 'list_files':
      return str('pattern') ?? 'all files';
    case 'git_log':
      return str('path') ? `history of ${str('path')}` : 'recent history';
    case 'show_commit':
      return str('sha')?.slice(0, 10) ?? '';
    case 'add_comment': {
      const path = str('filePath') ?? 'file';
      const line = num('newLine') ?? num('oldLine');
      const severity = str('severity');
      return severity ? `${path}${line !== null ? `:${line}` : ''} · ${severity}` : `${path}${line !== null ? `:${line}` : ''}`;
    }
    default:
      return '';
  }
}

/** Interleave response segments as styled spans, labelling reasoning vs. answer. */
function segmentsHtml(segments: ReviewOutputSegment[]): string {
  const runs: { kind: ReviewOutputSegment['kind']; text: string }[] = [];
  for (const s of segments) {
    const last = runs[runs.length - 1];
    if (last && last.kind === s.kind) last.text += s.text;
    else runs.push({ kind: s.kind, text: s.text });
  }
  const label = { reasoning: 'Reasoning', content: 'Answer' } as const;
  const mixed = runs.length > 1;
  return runs
    .map((r) => {
      const body = `<span class="review-log-${r.kind}">${esc(r.text)}</span>`;
      return mixed ? `<span class="review-log-seg-label">${label[r.kind]}</span>${body}` : body;
    })
    .join('');
}

/** A call's response as a `<pre>`, or a muted placeholder when nothing streamed. */
function responseHtml(segments: ReviewOutputSegment[]): string {
  if (segments.length === 0) {
    return '<pre class="review-log-response muted">(no response captured)</pre>';
  }
  return `<pre class="review-log-response">${segmentsHtml(segments)}</pre>`;
}

/** Chronological key: a model call precedes the tool calls it produced. */
function logKey(batchIndex: number, step: number, sub: number): number {
  return batchIndex * 1e6 + step * 2 + sub;
}

/** Render a job's model calls and their tool calls as one interleaved timeline. */
export function renderReviewLog(state: ReviewTabState, job: ReviewJob): void {
  let totalCompletion = 0;
  let totalDuration = 0;
  let sawEstimated = false;
  for (const p of job.prompts) {
    if (p.completionTokens !== null) totalCompletion += p.completionTokens;
    if (p.durationMs > 0) totalDuration += p.durationMs;
    if (p.usageEstimated) sawEstimated = true;
  }
  const totalRate = fmtRate(totalCompletion, totalDuration);
  const summary = [
    job.batchIndex >= 1 ? `Batch ${job.batchIndex}/${job.batchTotal}` : '',
    job.batchStep > 0 ? `Step ${job.batchStep}` : '',
    totalCompletion > 0 ? `${sawEstimated ? '~' : ''}${totalCompletion.toLocaleString('en-US')} tok` : '',
    totalRate,
    job.llmDurationMs > 0 ? `${fmtDuration(job.llmDurationMs)} LLM` : '',
  ].filter((s) => s.length > 0);
  $('#review-log-subtitle').textContent = summary.join(' · ');
  $('#review-log-trace-count').textContent = String(job.trace.length);
  // Reset per-step caches when a different job is shown.
  if (logJobId !== job.id) {
    logJobId = job.id;
    logStepCache.clear();
    logTextCache.clear();
    logOpenParts.clear();
    logOpenBatches.clear();
    logLoadingSteps.clear();
  }
  logRenderState = state;
  $('#review-log-prompt-count').textContent = String(job.prompts.length);
  // The timeline carries only step metadata; each call's prompt and response are
  // fetched on demand when their own toggle is expanded. Excluding the response
  // keeps the timeline from rebuilding on every streaming tick. Nothing
  // auto-opens: a call's Prompt and Response are expanded independently.
  const timelineSig =
    job.prompts
      .map((p) => `${p.batchIndex}:${p.step}:${p.chars}:${p.durationMs}:${p.promptTokens}:${p.completionTokens}:${p.usageEstimated ? 1 : 0}:${p.nudges}`)
      .join(',') +
    '|' +
    job.trace
      .map((t) => `${t.batchIndex}:${t.step}:${t.tool}:${JSON.stringify(t.args)}:${t.resultSummary}:${t.durationMs}`)
      .join(',') +
    '|' +
    `${job.state}:${job.batchIndex}:${job.batchStep}`;
  if (timelineSig !== logTimelineSig) {
    logTimelineSig = timelineSig;
    const timeline = $('#review-log-timeline');
    if (job.prompts.length === 0 && job.trace.length === 0) {
      timeline.innerHTML = '<p class="muted">Nothing logged yet.</p>';
    } else {
      // Build one list from both arrays, then sort by (batchIndex, step). A
      // resume-from-step appends new calls at the end of the arrays while earlier
      // batches stay put, so sorting is what keeps the timeline in batch order.
      // The sort is stable, so a model call precedes the tool calls it produced.
      const entries: { key: number; batchIndex: number; html: string }[] = [];
      const running = job.state === 'running';
      // The model call and its tool calls for the agent-loop step currently
      // executing, so the timeline can mark the in-progress step.
      const isCurrent = (batchIndex: number, step: number): boolean =>
        running && batchIndex === job.batchIndex && step === job.batchStep;
      job.prompts.forEach((p, pi) => {
        entries.push({
          key: logKey(p.batchIndex, p.step, 0),
          batchIndex: p.batchIndex,
          html:
            `<div class="review-log-call${isCurrent(p.batchIndex, p.step) ? ' is-current' : ''}" data-idx="${pi}">` +
            callHeaderHtml(p, pi, running) +
            `<details class="review-log-part" data-idx="${pi}" data-part="prompt"${logOpenParts.has(`${pi}:prompt`) ? ' open' : ''}>` +
            `<summary>Prompt</summary></details>` +
            `<details class="review-log-part" data-idx="${pi}" data-part="response"${logOpenParts.has(`${pi}:response`) ? ' open' : ''}>` +
            `<summary>Response</summary></details>` +
            `</div>`,
        });
      });
      job.trace.forEach((t) => {
        const detail = toolSummary(t.tool, t.args);
        entries.push({
          key: logKey(t.batchIndex, t.step, 1),
          batchIndex: t.batchIndex,
          html:
            `<details class="review-log-trace-item${isCurrent(t.batchIndex, t.step) ? ' is-current' : ''}">` +
            `<summary>` +
            `<span class="review-log-badge is-tool">${esc(t.tool)}</span>` +
            (detail ? `<span class="review-log-trace-summary">${esc(detail)}</span>` : '') +
            chip(fmtDuration(t.durationMs), 'is-dim') +
            `</summary>` +
            `<details class="review-log-args">` +
            `<summary>Arguments</summary>` +
            `<pre>${esc(JSON.stringify(t.args, null, 2))}</pre>` +
            `</details>` +
            `<span class="review-log-seg-label">Result</span>` +
            `<div class="trace-result">${esc(t.resultSummary)}</div>` +
            `</details>`,
        });
      });
      entries.sort((a, b) => a.key - b.key);
      // Per-batch summary metrics: model-call steps, tool calls, model-call time,
      // the batch's current nudge count (max across its calls), and the issues it
      // produced. Accepted comments are counted from the trace: a rejection or the
      // comment cap returns a different result summary, so those calls are excluded.
      const batchSteps = new Map<number, number>();
      const batchTools = new Map<number, number>();
      const batchTime = new Map<number, number>();
      const batchNudges = new Map<number, number>();
      const batchComments = new Map<number, number>();
      for (const p of job.prompts) {
        batchSteps.set(p.batchIndex, (batchSteps.get(p.batchIndex) ?? 0) + 1);
        batchTime.set(p.batchIndex, (batchTime.get(p.batchIndex) ?? 0) + p.durationMs);
        batchNudges.set(p.batchIndex, Math.max(batchNudges.get(p.batchIndex) ?? 0, p.nudges));
      }
      for (const t of job.trace) {
        batchTools.set(t.batchIndex, (batchTools.get(t.batchIndex) ?? 0) + 1);
        if (t.tool === 'add_comment' && t.resultSummary.startsWith('comment added')) {
          batchComments.set(t.batchIndex, (batchComments.get(t.batchIndex) ?? 0) + 1);
        }
      }
      const byBatch = new Map<number, string[]>();
      for (const e of entries) {
        const list = byBatch.get(e.batchIndex);
        if (list) list.push(e.html);
        else byBatch.set(e.batchIndex, [e.html]);
      }
      // One collapsible group per batch, collapsed by default; expanding it
      // reveals the step detail. The group's state is remembered across rebuilds.
      const parts: string[] = [];
      for (const batch of [...byBatch.keys()].sort((a, b) => a - b)) {
        const chips: string[] = [];
        const steps = batchSteps.get(batch) ?? 0;
        chips.push(chip(`${steps} step${steps === 1 ? '' : 's'}`));
        const tools = batchTools.get(batch) ?? 0;
        if (tools > 0) chips.push(chip(`${tools} tool call${tools === 1 ? '' : 's'}`));
        const time = fmtDuration(batchTime.get(batch) ?? 0);
        if (time !== '—') chips.push(chip(time));
        const issues = batchComments.get(batch) ?? 0;
        if (issues > 0) chips.push(chip(`${issues} issue${issues === 1 ? '' : 's'}`));
        const nudges = batchNudges.get(batch) ?? 0;
        if (nudges > 0) chips.push(chip(`${nudges} nudge${nudges === 1 ? '' : 's'}`, 'is-warn'));
        parts.push(
          `<details class="review-log-batch-group" data-batch="${batch}"${logOpenBatches.has(batch) ? ' open' : ''}>` +
            `<summary class="review-log-batch-head">` +
            `<span class="review-log-batch">Batch ${batch}/${job.batchTotal}</span>` +
            `<span class="review-log-metrics">${chips.join('')}</span>` +
            `</summary>` +
            `<div class="review-log-batch-body">${(byBatch.get(batch) ?? []).join('')}</div>` +
            `</details>`,
        );
      }
      timeline.innerHTML = parts.join('');
    }
  }
  // Fill the parts the user has open. A completed call is fetched in full; the
  // last (in-flight) call's response tracks its live streamed segments.
  const openIndices = new Set<number>();
  for (const key of logOpenParts) {
    const idx = Number(key.slice(0, key.indexOf(':')));
    if (Number.isInteger(idx)) openIndices.add(idx);
  }
  for (const i of openIndices) {
    const p = job.prompts[i];
    if (!p) continue;
    void fillLogStep(state, job, i, p.segments);
  }
}

/** Cached HTML of a part's body, so an unchanged re-render doesn't reset scroll. */
const logPartHtml = new WeakMap<HTMLElement, string>();

/** Replace a Prompt/Response toggle's body, keeping the toggle itself intact. */
function setPartContent(part: HTMLElement, html: string): void {
  let body = part.querySelector<HTMLElement>(':scope > .review-log-part-body');
  if (!body) {
    body = document.createElement('div');
    body.className = 'review-log-part-body';
    part.append(body);
  }
  if (logPartHtml.get(body) === html) return;
  logPartHtml.set(body, html);
  body.innerHTML = html;
}

/**
 * Render a call's prompt and response, fetching the full step from /review/log
 * when needed. A completed call is fetched once and cached; the in-flight (last,
 * running) call is never cached — its response comes from the lean streamed
 * segments and only its immutable prompt text is fetched.
 */
async function fillLogStep(
  state: ReviewTabState,
  job: ReviewJob,
  index: number,
  liveSegments: ReviewOutputSegment[],
): Promise<void> {
  const isInFlight = (): boolean => {
    const now = state.job ?? job;
    return index === now.prompts.length - 1 && now.state === 'running';
  };
  const promptOpen = logOpenParts.has(`${index}:prompt`);
  const responseOpen = logOpenParts.has(`${index}:response`);
  const needText = promptOpen && logTextCache.get(index) === undefined;
  const needFull = !isInFlight() && responseOpen && !logStepCache.has(index);
  let startedInFlight = false;
  if ((needText || needFull) && !logLoadingSteps.has(index)) {
    startedInFlight = isInFlight();
    logLoadingSteps.add(index);
    try {
      const { prompt } = await reviewApi<{ prompt: ReviewPromptStep }>(state, '/review/log', {
        jobId: job.id,
        index,
      });
      logTextCache.set(index, prompt.text);
      // Only cache the full step when the request was issued for an already
      // completed call: a response fetched mid-stream can be partial, and
      // caching it would freeze the incomplete output.
      if (!startedInFlight) logStepCache.set(index, prompt);
    } catch {
      for (const part of ['prompt', 'response'] as const) {
        if (!logOpenParts.has(`${index}:${part}`)) continue;
        const el = document.querySelector<HTMLElement>(
          `#review-log-timeline .review-log-part[data-idx="${index}"][data-part="${part}"]`,
        );
        if (el) setPartContent(el, '<p class="muted">Could not load this step.</p>');
      }
      return;
    } finally {
      logLoadingSteps.delete(index);
    }
    // The call finished while a mid-stream (text) fetch was in flight: its
    // response is now final, so fetch once more rather than rendering the
    // potentially-partial snapshot that fetch carries.
    if (startedInFlight && !isInFlight()) {
      void fillLogStep(state, job, index, liveSegments);
      return;
    }
  }
  const full = logStepCache.get(index);
  if (promptOpen) {
    const promptEl = document.querySelector<HTMLDetailsElement>(
      `#review-log-timeline .review-log-part[data-idx="${index}"][data-part="prompt"]`,
    );
    if (promptEl) {
      const text = logTextCache.get(index) ?? full?.text ?? '';
      setPartContent(promptEl, `<pre class="review-log-prompt">${esc(text)}</pre>`);
    }
  }
  if (responseOpen) {
    const responseEl = document.querySelector<HTMLDetailsElement>(
      `#review-log-timeline .review-log-part[data-idx="${index}"][data-part="response"]`,
    );
    if (responseEl) {
      const segments = isInFlight()
        ? liveSegments.length > 0
          ? liveSegments
          : full?.segments ?? []
        : full?.segments ?? [];
      setPartContent(responseEl, responseHtml(segments));
    }
  }
}

/** A short diff excerpt around a comment's anchor, or '' when it can't be located. */
/** A comment's ±2-line diff window, pre-split for the inline Monaco excerpt. */
export interface ExcerptWindow {
  /** Old-side text (context + deleted lines), newline-joined. */
  original: string;
  /** New-side text (context + added lines), newline-joined. */
  modified: string;
  /** Real file line number for each `original` model line. */
  originalLines: number[];
  /** Real file line number for each `modified` model line. */
  modifiedLines: number[];
  /** Real line numbers to highlight on each side. */
  anchors: { original?: number[]; modified?: number[] };
  /** Pixel height sized to the taller side. */
  height: number;
}

export const EXCERPT_LINE_HEIGHT = 19;

export const EXCERPT_MIN_HEIGHT = 56;

export const EXCERPT_MAX_HEIGHT = 150;

/** A comment's file plus its parsed diff lines, cached per `state.changes`. */
interface ParsedCommentFile {
  file: ReviewFile | undefined;
  lines: DiffLine[];
}

let parsedCacheChanges: ReviewChanges | null = null;

let parsedCacheByPath = new Map<string, ParsedCommentFile>();

/**
 * Parse a comment's file diff once per `state.changes`. The job is polled every
 * 800ms while running, and `state.changes` keeps its identity across those polls,
 * so this avoids re-parsing the whole patch for every comment on every tick.
 */
function parsedCommentFile(state: ReviewTabState, c: ReviewComment): ParsedCommentFile {
  const changes = state.changes;
  if (parsedCacheChanges !== changes) {
    parsedCacheChanges = changes;
    parsedCacheByPath = new Map();
  }
  const cached = parsedCacheByPath.get(c.filePath);
  if (cached) return cached;
  const file = changes?.files.find((f) => f.newPath === c.filePath || f.oldPath === c.filePath);
  const lines = file ? parsePatch(file.diff).flatMap((s) => s.hunks).flatMap((h) => h.lines) : [];
  const entry: ParsedCommentFile = { file, lines };
  parsedCacheByPath.set(c.filePath, entry);
  return entry;
}

/** Index of the comment's anchor line in a parsed diff, or -1 when not found. */
function anchorIndex(lines: DiffLine[], c: ReviewComment): number {
  if (c.newLine !== null) {
    const i = lines.findIndex((l) => l.newNo === c.newLine);
    if (i >= 0) return i;
  }
  if (c.oldLine !== null) return lines.findIndex((l) => l.oldNo === c.oldLine);
  return -1;
}

/**
 * Locate a comment's anchor in its file diff and build a small old/new window
 * around it. Returns null when the file, its diff, or the anchor can't be found.
 */
export function excerptWindow(state: ReviewTabState, c: ReviewComment): ExcerptWindow | null {
  if (c.oldLine === null && c.newLine === null) return null;
  const { lines } = parsedCommentFile(state, c);
  const anchor = anchorIndex(lines, c);
  if (anchor < 0) return null;
  const around: DiffLine[] = [];
  for (let i = anchor - 2; i <= anchor + 2; i++) {
    const line = lines[i];
    if (line && line.kind !== 'nonewline') around.push(line);
  }
  const oldText: string[] = [];
  const newText: string[] = [];
  const originalLines: number[] = [];
  const modifiedLines: number[] = [];
  const anchors: ExcerptWindow['anchors'] = {};
  for (const line of around) {
    const isAnchor =
      (c.newLine !== null && line.newNo === c.newLine) ||
      (c.oldLine !== null && line.oldNo === c.oldLine);
    if (line.kind !== 'add') {
      oldText.push(line.text);
      originalLines.push(line.oldNo ?? originalLines[originalLines.length - 1] ?? 1);
      if (isAnchor && line.oldNo !== null) (anchors.original ??= []).push(line.oldNo);
    }
    if (line.kind !== 'del') {
      newText.push(line.text);
      modifiedLines.push(line.newNo ?? modifiedLines[modifiedLines.length - 1] ?? 1);
      if (isAnchor && line.newNo !== null) (anchors.modified ??= []).push(line.newNo);
    }
  }
  if (oldText.length === 0 && newText.length === 0) return null;
  const rows = Math.max(oldText.length, newText.length);
  const height = Math.min(EXCERPT_MAX_HEIGHT, Math.max(EXCERPT_MIN_HEIGHT, rows * EXCERPT_LINE_HEIGHT + 10));
  return {
    original: oldText.join('\n'),
    modified: newText.join('\n'),
    originalLines,
    modifiedLines,
    anchors,
    height,
  };
}

/**
 * A short diff excerpt around a comment's anchor. Emits the hand-rolled HTML
 * window (used verbatim when Monaco is unavailable); `mountExcerptEditors`
 * upgrades it to an inline Monaco diff when the module has loaded.
 */
export function commentExcerptHtml(state: ReviewTabState, c: ReviewComment): string {
  const win = excerptWindow(state, c);
  if (!win) return '';
  const { lines } = parsedCommentFile(state, c);
  const anchor = anchorIndex(lines, c);
  const rows: string[] = [];
  for (let i = anchor - 2; i <= anchor + 2; i++) {
    const line = lines[i];
    if (!line || line.kind === 'nonewline') continue;
    const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
    const anchorCls =
      (c.newLine !== null && line.newNo === c.newLine) || (c.oldLine !== null && line.oldNo === c.oldLine)
        ? ' dl-anchor'
        : '';
    rows.push(
      `<div class="dl-row dl-${line.kind}${anchorCls}">${gutter(line.oldNo)}${gutter(line.newNo)}<span class="dl-sign">${sign}</span><span class="dl-text">${esc(line.text)}</span></div>`,
    );
  }
  return `<div class="review-comment-excerpt diff-body" data-excerpt="${esc(c.id)}">${rows.join('')}</div>`;
}

/** A mounted Monaco diff excerpt and the signature of its rendered contents. */
interface MountedExcerpt {
  handle: CodeHandle;
  signature: string;
}

/**
 * Monaco diff editors mounted for the visible review excerpts, keyed by comment
 * id so a poll tick can reuse the unchanged ones instead of rebuilding them all.
 */
export let excerptHandles = new Map<string, MountedExcerpt>();

/** Tear down every mounted excerpt editor (tab close / full reset). */
export function disposeExcerptEditors(): void {
  for (const mounted of excerptHandles.values()) mounted.handle.dispose();
  excerptHandles = new Map();
}

/** Everything that affects a rendered excerpt; remount only when this changes. */
function excerptSignature(win: ExcerptWindow, c: ReviewComment): string {
  return [
    c.filePath,
    c.oldLine ?? '',
    c.newLine ?? '',
    win.original,
    win.modified,
    win.originalLines.join(','),
    win.modifiedLines.join(','),
    win.anchors.original?.join(',') ?? '',
    win.anchors.modified?.join(',') ?? '',
    win.height,
  ].join('\u0000');
}

/**
 * Upgrade each rendered excerpt placeholder to an inline Monaco diff. Unchanged
 * excerpts (same signature as the mounted handle) are left untouched so a poll
 * tick no longer tears down and rebuilds every editor. When Monaco is unavailable
 * the placeholder's hand-rolled HTML stays in place.
 */
export async function mountExcerptEditors(state: ReviewTabState, list: HTMLElement): Promise<void> {
  const hosts = list.querySelectorAll<HTMLElement>('.review-comment-excerpt[data-excerpt]');
  if (hosts.length === 0) {
    disposeExcerptEditors();
    return;
  }
  const code = await loadCode();
  if (!code) return;
  const live = new Set<string>();
  for (const host of hosts) {
    const id = host.dataset.excerpt ?? '';
    const c = state.job?.comments.find((x) => x.id === id);
    if (!c) continue;
    const win = excerptWindow(state, c);
    if (!win) continue;
    live.add(id);
    const signature = excerptSignature(win, c);
    const mounted = excerptHandles.get(id);
    if (mounted && mounted.signature === signature) continue;
    mounted?.handle.dispose();
    host.classList.add('is-code');
    host.innerHTML = '';
    const mount = document.createElement('div');
    mount.className = 'code-host';
    mount.style.height = `${win.height}px`;
    host.appendChild(mount);
    excerptHandles.set(id, {
      signature,
      handle: code.createDiffEditor(mount, win.original, win.modified, {
        path: c.filePath,
        sideBySide: false,
        lineNumbers: { original: win.originalLines, modified: win.modifiedLines },
        anchors: win.anchors,
        consumeMouseWheel: false,
      }),
    });
  }
  // Drop handles for comments no longer rendered (filtered/rejected/removed).
  for (const [id, mounted] of excerptHandles) {
    if (!live.has(id)) {
      mounted.handle.dispose();
      excerptHandles.delete(id);
    }
  }
}

/** Human label for a comment's anchor line. */
function commentLineLabel(c: ReviewComment): string {
  return c.newLine !== null
    ? `new line ${c.newLine}`
    : c.oldLine !== null
      ? `old line ${c.oldLine}`
      : 'general';
}

/** Fields that require rebuilding a card's markup (the excerpt lives here too). */
function commentStructuralSig(c: ReviewComment): string {
  return [c.severity, c.filePath, c.oldLine ?? '', c.newLine ?? '', c.stage].join('\u0000');
}

/** Fields that can be patched in place without touching the excerpt. */
function commentMetaSig(c: ReviewComment): string {
  return [c.status, c.body].join('\u0000');
}

/**
 * Grow a comment body to fit its full text. Resetting `height` first lets the
 * textarea fall back to its intrinsic `rows="3"` height, so short comments keep
 * their original size while long ones expand instead of scrolling internally.
 */
function autosizeCommentBody(ta: HTMLTextAreaElement): void {
  if (!ta.isConnected || ta.offsetParent === null) return;
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight + ta.offsetHeight - ta.clientHeight}px`;
}

function autosizeCommentBodies(root: ParentNode): void {
  for (const ta of root.querySelectorAll<HTMLTextAreaElement>('.review-comment-body')) autosizeCommentBody(ta);
}

/** Build a fresh comment card (with the HTML excerpt fallback) and wire it up. */
function createCommentCard(state: ReviewTabState, c: ReviewComment): HTMLElement {
  const line = commentLineLabel(c);
  const localOnly = !!state.changes?.commit || !!state.changes?.compare;
  const scanning = c.stage === 'pending' && state.job?.state === 'running';
  const stage = scanning ? '<span class="review-stage-badge">scanning…</span>' : '';
  const template = document.createElement('template');
  template.innerHTML = `
    <div class="review-comment-card${scanning ? ' is-pending' : ''}" data-id="${esc(c.id)}">
      <div class="review-comment-head">
        <span class="severity severity-${esc(c.severity)}">${esc(c.severity)}</span>
        <code>${esc(c.filePath)}</code>
        <span class="muted">${esc(line)}</span>
        ${stage}
        <span class="review-status-badge status-${esc(c.status)}">${esc(c.status)}</span>
      </div>
      ${commentExcerptHtml(state, c)}
      <textarea class="review-comment-body" rows="3" data-id="${esc(c.id)}">${esc(c.body)}</textarea>
      <div class="review-comment-actions">
        <button type="button" class="btn review-comment-reject" data-id="${esc(c.id)}">Reject</button>
        ${
          localOnly
            ? ''
            : `<button type="button" class="btn review-comment-approve" data-id="${esc(c.id)}">Post comment</button>`
        }
      </div>
    </div>`;
  const card = template.content.firstElementChild as HTMLElement;
  const ta = card.querySelector<HTMLTextAreaElement>('.review-comment-body');
  ta?.addEventListener('input', () => {
    if (!ta) return;
    const id = ta.dataset.id ?? '';
    const target = state.job?.comments.find((x) => x.id === id);
    if (target) target.body = ta.value;
    const edit = state.edits.get(id) ?? {
      body: target?.body ?? ta.value,
      status: target?.status ?? 'pending',
    };
    edit.body = ta.value;
    state.edits.set(id, edit);
    autosizeCommentBody(ta);
    window.clearTimeout(state.saveTimer);
    state.saveTimer = window.setTimeout(() => void persistSessionEdits(state), 800);
  });
  card
    .querySelector<HTMLButtonElement>('.review-comment-approve')
    ?.addEventListener('click', (ev) => void approveComment(state, (ev.currentTarget as HTMLElement).dataset.id ?? ''));
  card
    .querySelector<HTMLButtonElement>('.review-comment-reject')
    ?.addEventListener('click', (ev) => void rejectComment(state, (ev.currentTarget as HTMLElement).dataset.id ?? ''));
  card.dataset.structural = commentStructuralSig(c);
  card.dataset.meta = commentMetaSig(c);
  return card;
}

/** Patch a card's status badge and body without rebuilding its excerpt. */
function updateCommentCard(card: HTMLElement, c: ReviewComment, running: boolean): void {
  card.dataset.meta = commentMetaSig(c);
  card.classList.toggle('is-pending', c.stage === 'pending' && running);
  const badge = card.querySelector<HTMLElement>('.review-status-badge');
  if (badge) {
    badge.className = `review-status-badge status-${c.status}`;
    badge.textContent = c.status;
  }
  const ta = card.querySelector<HTMLTextAreaElement>('.review-comment-body');
  if (ta && document.activeElement !== ta && ta.value !== c.body) {
    ta.value = c.body;
    autosizeCommentBody(ta);
  }
}

/**
 * Reconcile the comment list against `visible`, keyed by comment id. Unchanged
 * cards (and their mounted Monaco excerpts) are left alone, so the 800ms poll no
 * longer destroys and rebuilds the whole list while a review runs.
 */
function reconcileCommentList(state: ReviewTabState, list: HTMLElement, visible: ReviewComment[]): void {
  if (visible.length === 0) {
    if (list.querySelector(':scope > .review-comment-card[data-id]')) {
      disposeExcerptEditors();
      list.innerHTML = '<p class="muted review-comment-empty">No comments to show.</p>';
    }
    return;
  }
  list.querySelector(':scope > .review-comment-empty')?.remove();
  const current = new Map<string, HTMLElement>();
  for (const card of list.querySelectorAll<HTMLElement>(':scope > .review-comment-card[data-id]')) {
    current.set(card.dataset.id ?? '', card);
  }
  const ordered: HTMLElement[] = [];
  for (const c of visible) {
    const structural = commentStructuralSig(c);
    let card = current.get(c.id);
    if (card && card.dataset.structural === structural) {
      if (card.dataset.meta !== commentMetaSig(c)) {
        updateCommentCard(card, c, state.job?.state === 'running');
      }
    } else {
      if (card) {
        excerptHandles.get(c.id)?.handle.dispose();
        excerptHandles.delete(c.id);
      }
      const fresh = createCommentCard(state, c);
      if (card) card.replaceWith(fresh);
      else list.appendChild(fresh);
      card = fresh;
      const ta = fresh.querySelector<HTMLTextAreaElement>('.review-comment-body');
      if (ta) autosizeCommentBody(ta);
    }
    current.delete(c.id);
    ordered.push(card);
  }
  // Drop cards for comments no longer visible, along with their excerpts.
  for (const [id, card] of current) {
    excerptHandles.get(id)?.handle.dispose();
    excerptHandles.delete(id);
    card.remove();
  }
  // Restore order only when it actually changed (moving a card re-lays-out Monaco).
  let inOrder = list.children.length === ordered.length;
  for (let i = 0; inOrder && i < ordered.length; i++) {
    if (list.children[i] !== ordered[i]) inOrder = false;
  }
  if (!inOrder) for (const card of ordered) list.appendChild(card);
}

/** Re-apply local edits/approvals so a poll snapshot never clobbers typing. */
function applyCommentEdits(state: ReviewTabState, comments: ReviewComment[]): void {
  for (const c of comments) {
    const edit = state.edits.get(c.id);
    if (edit) {
      c.body = edit.body;
      c.status = edit.status;
    }
  }
}

function commentsEmptyText(state: ReviewTabState): string {
  const job = state.job;
  if (!job) return 'No proposed comments yet.';
  if (job.state === 'running') return 'Waiting for proposed comments…';
  if (job.comments.length > 0) return 'All proposed comments are posted.';
  return 'No proposed comments.';
}

function paintCommentsEmpty(state: ReviewTabState): void {
  const el = $('#review-comments-empty');
  const unposted = state.job?.comments.filter((c) => c.status !== 'posted').length ?? 0;
  el.hidden = unposted > 0;
  if (unposted === 0) el.textContent = commentsEmptyText(state);
}

/** Keep the Changes/Comments subtab badges in step with the target and job. */
function updateReviewPaneBadges(state: ReviewTabState): void {
  const files = state.changes?.files.length ?? 0;
  $('#review-subtab-changes-count').textContent = files > 0 ? `(${files})` : '';
  const unposted = state.job?.comments.filter((c) => c.status !== 'posted').length ?? 0;
  $('#review-subtab-comments-count').textContent = unposted > 0 ? `(${unposted})` : '';
}

/** Show the active Changes/Comments subtab and update its badges/empty state. */
export function paintReviewPane(state: ReviewTabState): void {
  if (!isReviewShown(state)) return;
  const pane = state.reviewPane;
  document.querySelectorAll<HTMLButtonElement>('.review-subtab').forEach((btn) => {
    const active = btn.dataset.reviewPane === pane;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  $('#review-changes-pane').hidden = pane !== 'changes';
  $('#review-comments-pane').hidden = pane !== 'comments';
  updateReviewPaneBadges(state);
  paintCommentsEmpty(state);
  if (pane === 'changes') requestAnimationFrame(() => layoutReviewDiff(state));
  else if (isReviewShown(state)) renderCommentQueue(state);
}

export function renderCommentQueue(state: ReviewTabState): void {
  const job = state.job;
  if (!job || job.comments.length === 0) {
    $('#review-queue-wrap').hidden = true;
    updateReviewPaneBadges(state);
    paintCommentsEmpty(state);
    return;
  }
  applyCommentEdits(state, job.comments);
  // Posted comments are done: hide them (and the queue itself when none remain).
  const unposted = job.comments.filter((c) => c.status !== 'posted');
  if (unposted.length === 0) {
    $('#review-queue-wrap').hidden = true;
    updateReviewPaneBadges(state);
    paintCommentsEmpty(state);
    return;
  }
  $('#review-queue-wrap').hidden = false;
  updateReviewPaneBadges(state);
  paintCommentsEmpty(state);
  const total = unposted.length;
  const pending =
    job.state === 'running' ? unposted.filter((c) => c.stage === 'pending').length : 0;
  const rejected = unposted.filter((c) => c.status === 'rejected').length;
  $('#review-queue-count').textContent = pending > 0 ? `(${total}, ${pending} scanning…)` : `(${total})`;
  const toggle = $<HTMLButtonElement>('#review-toggle-rejected');
  toggle.hidden = rejected === 0;
  toggle.textContent = state.showRejected ? 'Hide rejected' : `Show rejected (${rejected})`;
  const visible = unposted.filter((c) => state.showRejected || c.status !== 'rejected');
  const list = $('#review-comment-list');
  reconcileCommentList(state, list, visible);
  // Upgrade the excerpt placeholders to inline Monaco diffs (no-op if unavailable).
  if (isReviewShown(state) && state.reviewPane === 'comments') void mountExcerptEditors(state, list);
}

/** Record a comment's local status/body so a poll re-render preserves it. */
export function setCommentStatus(state: ReviewTabState, c: ReviewComment, status: ReviewCommentStatus): void {
  c.status = status;
  const edit = state.edits.get(c.id) ?? { body: c.body, status };
  edit.body = c.body;
  edit.status = status;
  state.edits.set(c.id, edit);
}

/** Approve a comment: mark it, then post that comment alone to the MR. */
export async function approveComment(state: ReviewTabState, id: string): Promise<void> {
  if (state.changes?.commit || state.changes?.compare) return;
  const c = state.job?.comments.find((x) => x.id === id);
  if (!c || c.status === 'posted' || state.sending.has(id)) return;
  state.sending.add(id);
  setCommentStatus(state, c, 'approved');
  if (isReviewShown(state)) renderCommentQueue(state);
  void persistSessionEdits(state);
  try {
    await sendComment(state, id);
  } finally {
    state.sending.delete(id);
    if (isReviewShown(state)) renderCommentQueue(state);
  }
}

/** Reject a comment: mark it and hide it from the queue. */
export function rejectComment(state: ReviewTabState, id: string): void {
  const c = state.job?.comments.find((x) => x.id === id);
  if (!c) return;
  setCommentStatus(state, c, 'rejected');
  if (isReviewShown(state)) renderCommentQueue(state);
  void persistSessionEdits(state);
}

/** Post a single approved comment and fold the result back into the queue. */
export async function sendComment(state: ReviewTabState, id: string): Promise<void> {
  const job = state.job;
  const changes = state.changes;
  if (!job || !changes || changes.commit || changes.compare) return;
  const c = job.comments.find((x) => x.id === id);
  if (!c) return;
  const status = $('#review-status');
  const shown = isReviewShown(state);
  if (shown) status.textContent = 'Posting comment…';
  try {
    const { results } = await reviewApi<{
      results: Array<{ id: string; ok: boolean; discussionId?: string; error?: string }>;
    }>(state, '/review/post', {
      iid: changes.mr.iid,
      comments: [c],
      diffRefs: changes.diffRefs,
      forge: changes.forge,
    });
    const r = results[0];
    if (r) {
      if (r.ok) {
        c.status = 'posted';
        c.discussionId = r.discussionId ?? null;
      } else {
        c.status = 'failed';
        c.error = r.error ?? 'post failed';
      }
      const edit = state.edits.get(c.id);
      if (edit) edit.status = c.status;
    }
    if (isReviewShown(state)) {
      renderCommentQueue(state);
      status.textContent =
        c.status === 'posted' ? 'Comment posted.' : `Post failed: ${c.error ?? 'unknown error'}`;
    }
    void persistSessionEdits(state);
  } catch (err) {
    if (shown) status.textContent = String(err);
  }
}

/**
 * Toggle the review action buttons for the current job (null = no active
 * review). An active session (running or paused) hides "Review with AI" so the
 * row shows Pause/Cancel (or Resume/Cancel) instead.
 */
function paintJobControls(state: ReviewTabState | null, job: ReviewJob | null): void {
  const jobState = job?.state ?? null;
  // A commit review has no request to start over; re-open it from the graph.
  $('#review-generate').hidden =
    !!state?.changes?.commit || jobState === 'running' || jobState === 'paused';
  $('#review-pause-job').hidden = jobState !== 'running';
  $('#review-resume-job').hidden = jobState !== 'paused' && jobState !== 'error';
  $('#review-cancel-job').hidden = jobState !== 'running' && jobState !== 'paused';
  const progress = $<HTMLButtonElement>('#review-progress');
  progress.hidden = jobState === null;
  progress.setAttribute('aria-busy', jobState === 'running' ? 'true' : 'false');
}

export function renderJob(state: ReviewTabState, job: ReviewJob): void {
  paintJobControls(state, job);
  // Paused and errored jobs are both resumable: resume re-issues the last step
  // (from the checkpoint when there is one, else the current batch from scratch).
  const stalled = job.state === 'paused' && job.stalledBatch !== null;
  $('#review-resume-job').textContent = job.state === 'error' || stalled ? 'Continue' : 'Resume';
  $('#review-progress-text').textContent = `Batch ${job.batchIndex}/${job.batchTotal} · Step ${job.batchStep}`;
  if ($<HTMLDialogElement>('#review-log-dialog').open) renderReviewLog(state, job);
  if (job.comments.length > 0) renderCommentQueue(state);
  paintReviewWarning(state);
  if (job.state === 'error') {
    $('#review-status').textContent = `Review failed: ${job.error ?? 'unknown error'}`;
  } else if (job.state === 'cancelled') {
    $('#review-status').textContent = 'Review cancelled.';
  } else if (job.state === 'paused') {
    $('#review-status').textContent = stalled
      ? `Batch ${job.stalledBatch} ended without finish_batch (loop) — Continue to keep reviewing, ` +
        'or open the model log and resume from an earlier step.'
      : 'Review paused — resume to continue.';
  } else if (job.state === 'done') {
    $('#review-status').textContent = `Review complete: ${job.comments.length} comment(s).`;
  }
}

/**
 * Poll a running job. A background review tab keeps polling so its state stays
 * fresh, but only touches the DOM while it is the visible view.
 */
export async function pollJob(state: ReviewTabState): Promise<void> {
  if (!state.job) return;
  const jobId = state.job.id;
  const wasRunning = state.job.state === 'running';
  try {
    const { job } = await reviewApi<{ job: ReviewJob }>(state, '/review/status', { jobId });
    // A restore or another poll may have replaced the job while this was in
    // flight; never let an older snapshot overwrite the current session.
    if (state.job?.id !== jobId || job.id !== jobId) return;
    state.job = job;
    applyCommentEdits(state, job.comments);
    if (wasRunning !== (job.state === 'running')) renderTabs();
    if (isReviewShown(state)) renderJob(state, job);
    if (job.state === 'running') {
      state.poll = window.setTimeout(() => void pollJob(state), 800);
    } else {
      void loadReviewSessions(state);
    }
  } catch (err) {
    if (isReviewShown(state)) $('#review-status').textContent = String(err);
  }
}

/** Persist local comment edits/approvals onto the stored session. */
export async function persistSessionEdits(state: ReviewTabState): Promise<void> {
  if (!state.job) return;
  const comments = state.job.comments;
  try {
    await reviewApi(state, '/review/session/save', { sessionId: state.job.id, comments });
    void loadReviewSessions(state);
  } catch {
    // Persistence is best-effort; the in-memory edits are still intact.
  }
}

/** Load the selected MR, then start a review job for it. */
export async function generateReview(): Promise<void> {
  const state = activeReview();
  if (!state || state.mode !== 'request' || state.changes?.commit || state.changes?.compare) return;
  if (!(await loadSelectedMr(true))) return;
  if (!state.changes) return;
  const status = $('#review-status');
  status.textContent = 'Starting review…';
  try {
    const { job } = await reviewApi<{ job: ReviewJob }>(state, '/review/generate', {
      iid: state.changes.mr.iid,
    });
    state.job = job;
    rememberStartedSession(state, job);
    state.edits.clear();
    state.showRejected = false;
    $('#review-queue-wrap').hidden = true;
    status.textContent = '';
    renderJob(state, job);
    renderTabs();
    window.clearTimeout(state.poll);
    state.poll = window.setTimeout(() => void pollJob(state), 600);
    void loadReviewSessions(state);
  } catch (err) {
    status.textContent = String(err);
  }
}

/** Check out the selected request's source branch and reset it to the request head. */
export async function checkoutMrBranch(): Promise<void> {
  const state = activeReview();
  const changes = state?.changes;
  if (!state || !changes || changes.commit || changes.compare) return;
  const branch = changes.mr.sourceBranch.trim();
  const { short } = forgeLabels(changes.forge);
  const status = $('#review-status');
  const proceed = await confirmDialog({
    title: `Checkout ${short} branch?`,
    message:
      `Check out "${branch}" and reset it to the ${short} head. ` +
      `If the local branch already exists and has diverged, its local commits and uncommitted changes will be discarded.`,
    confirmLabel: 'Checkout & reset',
    danger: true,
  });
  if (!proceed) return;
  status.textContent = `Checking out ${branch}…`;
  try {
    const { output } = await reviewApi<{ output: string }>(state, '/review/checkout-branch', {
      iid: changes.mr.iid,
      branch,
      forge: changes.forge,
    });
    await refresh();
    // The branch is now up to date locally, so a pre-run head-fetch warning no
    // longer applies (an already-run job keeps its own diff-only trace note).
    state.headWarning = null;
    paintReviewWarning(state);
    status.textContent = output.trim() || `Checked out ${branch}.`;
  } catch (err) {
    status.textContent = String(err);
  }
}

/** Short display form of a ref (commit SHAs abridged). */
function refLabel(ref: string): string {
  return /^[0-9a-f]{40}$/i.test(ref) ? ref.slice(0, 10) : ref;
}

interface CompareRefOption {
  name: string;
  isRemote: boolean;
  isTag?: boolean;
}

/** Branches, remote-tracking refs, and tags available for a local comparison. */
function compareRefs(state: ReviewTabState): CompareRefOption[] {
  const tab = store.tabs.find((t) => t.id === state.repoId);
  const resp = tab?.lastResponse ?? (state.repoId === store.activeId ? store.lastResponse : null);
  const out: CompareRefOption[] = [];
  const seen = new Set<string>();
  for (const branch of resp?.state?.branches ?? []) {
    if (!branch.name || branch.name.endsWith('/HEAD') || seen.has(branch.name)) continue;
    seen.add(branch.name);
    out.push({ name: branch.name, isRemote: branch.isRemote });
  }
  if (resp?.state?.detachedHead && !seen.has('HEAD')) {
    seen.add('HEAD');
    out.unshift({ name: 'HEAD', isRemote: false });
  }
  for (const commit of resp?.commits ?? []) {
    for (const ref of commit.refs) {
      if (ref.kind !== 'tag' || !ref.name || seen.has(ref.name)) continue;
      seen.add(ref.name);
      out.push({ name: ref.name, isRemote: false, isTag: true });
    }
  }
  return out;
}

function preferredBaseRef(refs: CompareRefOption[]): string {
  const names = new Set(refs.map((r) => r.name));
  for (const candidate of ['origin/main', 'main', 'origin/master', 'master']) {
    if (names.has(candidate)) return candidate;
  }
  return refs.find((r) => r.isRemote)?.name ?? refs[0]?.name ?? '';
}

function preferredHeadRef(state: ReviewTabState, refs: CompareRefOption[]): string {
  const tab = store.tabs.find((t) => t.id === state.repoId);
  const resp = tab?.lastResponse ?? (state.repoId === store.activeId ? store.lastResponse : null);
  const head = resp?.state?.headBranch;
  if (head && refs.some((r) => r.name === head)) return head;
  if (refs.some((r) => r.name === 'HEAD')) return 'HEAD';
  return refs.find((r) => !r.isRemote && !r.isTag)?.name ?? refs[0]?.name ?? '';
}

function fillRefSelect(select: HTMLSelectElement, refs: CompareRefOption[], current: string): void {
  const known = refs.some((r) => r.name === current);
  const pinned =
    current && !known
      ? `<option value="${esc(current)}">${esc(refLabel(current))}${
          /^[0-9a-f]{40}$/i.test(current) ? ' (commit)' : ''
        }</option>`
      : '';
  const group = (label: string, list: CompareRefOption[]): string =>
    list.length === 0
      ? ''
      : `<optgroup label="${esc(label)}">${list
          .map((r) => `<option value="${esc(r.name)}">${esc(r.name)}</option>`)
          .join('')}</optgroup>`;
  select.innerHTML =
    pinned +
    group('Local', refs.filter((r) => !r.isRemote && !r.isTag)) +
    group('Tags', refs.filter((r) => r.isTag)) +
    group('Remote', refs.filter((r) => r.isRemote));
  if (current) select.value = current;
}

/** Fill the compare bar and keep its buttons/hint in step with the refs. */
function paintCompareForm(state: ReviewTabState): void {
  if (!isReviewShown(state)) return;
  const refs = compareRefs(state);
  if (!state.compareBase) state.compareBase = preferredBaseRef(refs);
  if (!state.compareHead) state.compareHead = preferredHeadRef(state, refs);
  fillRefSelect($<HTMLSelectElement>('#review-compare-base'), refs, state.compareBase);
  fillRefSelect($<HTMLSelectElement>('#review-compare-head'), refs, state.compareHead);
  const ready = !!state.compareBase && !!state.compareHead;
  $<HTMLButtonElement>('#review-compare-run').toggleAttribute('disabled', !ready);
  if (state.mode === 'compare') {
    $<HTMLButtonElement>('#review-generate').toggleAttribute('disabled', !ready);
  }
  const hint = $('#review-compare-hint');
  const commit = state.changes?.commit;
  const usesRemote = refs.some(
    (r) => r.isRemote && (r.name === state.compareBase || r.name === state.compareHead),
  );
  if (state.mode !== 'compare') {
    hint.hidden = true;
    hint.textContent = '';
  } else if (commit) {
    hint.hidden = false;
    hint.textContent = commit.baseHash
      ? `Reviewing commit ${commit.shortHash} against its first parent.`
      : `Reviewing root commit ${commit.shortHash} (no parent).`;
  } else if (refs.length === 0) {
    hint.hidden = false;
    hint.textContent = 'No local branches, remote branches, or tags are available to compare.';
  } else if (usesRemote) {
    hint.hidden = false;
    hint.textContent =
      'Comparing the two branch tips directly (base..head). Remote-tracking refs are used ' +
      'as last fetched — pull to refresh them before comparing.';
  } else {
    hint.hidden = false;
    hint.textContent = 'Comparing the two branch tips directly (base..head).';
  }
}

/** Forget the current review target without touching a running server-side job. */
function clearReviewTarget(state: ReviewTabState): void {
  window.clearTimeout(state.poll);
  window.clearTimeout(state.saveTimer);
  state.poll = undefined;
  state.saveTimer = undefined;
  state.changes = null;
  state.job = null;
  state.edits.clear();
  state.sending.clear();
  state.showRejected = false;
  state.headWarning = null;
  state.mrIid = 0;
  state.selectedFile = null;
  state.diffFile = 0;
  state.diffHunk = -1;
  state.diffFor = null;
}

/** Confirm replacing a running review; finished/paused sessions are kept on disk. */
function confirmReplaceReview(
  state: ReviewTabState,
  title: string,
  confirmLabel: string,
): Promise<boolean> {
  if (state.job?.state !== 'running') return Promise.resolve(true);
  return confirmDialog({
    title,
    message:
      'A review is running in this tab. Starting a new target hides it; it keeps ' +
      'running in the background and remains available under Saved reviews.',
    confirmLabel,
  });
}

/** Load a local comparison's changed files without starting an AI review. */
async function runCompare(
  state: ReviewTabState,
  refs?: { base: string; head: string },
): Promise<void> {
  const base = refs?.base ?? $<HTMLSelectElement>('#review-compare-base').value;
  const head = refs?.head ?? $<HTMLSelectElement>('#review-compare-head').value;
  const status = $('#review-status');
  if (!base || !head) {
    status.textContent = 'Choose a base and a head ref to compare.';
    return;
  }
  if (!(await confirmReplaceReview(state, 'Start a comparison?', 'Compare'))) return;
  clearReviewTarget(state);
  state.mode = 'compare';
  state.compareBase = base;
  state.compareHead = head;
  paintForgeWording(state);
  paintCompareForm(state);
  status.textContent = 'Comparing…';
  try {
    const { changes } = await reviewApi<{ changes: ReviewChanges }>(state, '/compare', {
      base,
      head,
      mergeBase: false,
    });
    state.changes = changes;
    state.selectedFile = null;
    renderTabs();
    if (!isReviewShown(state)) return;
    refreshSessionSelect(state);
    paintForgeWording(state);
    paintCompareForm(state);
    renderReviewChanges(state);
    paintReviewPane(state);
    $('#review-queue-wrap').hidden = true;
    paintJobControls(state, null);
    $('#review-approve-mr').hidden = true;
    status.textContent = '';
  } catch (err) {
    status.textContent = String(err);
  }
}

/** Start a local-only AI review for the comparison currently in the form. */
async function generateCompareReview(state: ReviewTabState): Promise<void> {
  const base = $<HTMLSelectElement>('#review-compare-base').value;
  const head = $<HTMLSelectElement>('#review-compare-head').value;
  const status = $('#review-status');
  if (!base || !head) {
    status.textContent = 'Choose a base and a head ref to compare.';
    return;
  }
  if (!(await confirmReplaceReview(state, 'Start a comparison review?', 'Start review'))) return;
  clearReviewTarget(state);
  state.mode = 'compare';
  state.compareBase = base;
  state.compareHead = head;
  status.textContent = 'Starting comparison review…';
  try {
    const { job, changes } = await reviewApi<{ job: ReviewJob; changes: ReviewChanges }>(
      state,
      '/review/generate-compare',
      { base, head, mergeBase: false },
    );
    state.changes = changes;
    state.job = job;
    state.selectedFile = null;
    rememberStartedSession(state, job);
    state.edits.clear();
    state.showRejected = false;
    state.headWarning = null;
    renderTabs();
    if (isReviewShown(state)) {
      refreshSessionSelect(state);
      paintForgeWording(state);
      paintCompareForm(state);
      renderReviewChanges(state);
      $('#review-queue-wrap').hidden = true;
      renderJob(state, job);
      paintReviewPane(state);
    }
    status.textContent = '';
    window.clearTimeout(state.poll);
    state.poll = window.setTimeout(() => void pollJob(state), 600);
    void loadReviewSessions(state);
  } catch (err) {
    status.textContent = String(err);
  }
}

/** Open the comparison panel from the graph context menu. */
async function openCompareReview(base: string, head: string): Promise<void> {
  const state = ensureReviewState('compare');
  if (!state) return;
  if (!(await confirmReplaceReview(state, 'Start a comparison?', 'Compare'))) return;
  clearReviewTarget(state);
  state.compareBase = base;
  state.compareHead = head;
  showReviewPanel(state);
  await runCompare(state, { base, head });
}

/** Create a review state for one repository and mode. */
export function createReviewState(
  repoId: string,
  repoPath: string,
  mode: 'request' | 'compare',
): ReviewTabState {
  return {
    repoId,
    repoPath,
    changes: null,
    job: null,
    poll: undefined,
    saveTimer: undefined,
    edits: new Map(),
    mrs: [],
    mrIid: 0,
    sessions: [],
    showRejected: false,
    sending: new Set(),
    headWarning: null,
    mode,
    compareBase: '',
    compareHead: '',
    selectedFile: null,
    diffLayout: readDiffView(),
    reviewPane: 'changes',
    diffFile: 0,
    diffHunk: -1,
    diffFor: null,
  };
}

/** The active repository's review state for one mode, creating it on first use. */
function ensureReviewState(mode: 'request' | 'compare'): ReviewTabState | null {
  if (!store.activeId) {
    toast('Open a repository first.', 'info');
    return null;
  }
  const tab = activeTab();
  if (!tab) return null;
  const existing = mode === 'compare' ? tab.compare : tab.review;
  if (existing) return existing;
  const state = createReviewState(store.activeId, tab.path, mode);
  if (mode === 'compare') tab.compare = state;
  else tab.review = state;
  return state;
}

/** Show one review/compare panel and refresh its pickers. */
function showReviewPanel(state: ReviewTabState): void {
  store.activePanel = { kind: 'review', repoId: state.repoId, mode: state.mode };
  resetReviewDom();
  refreshMrSelect(state);
  refreshSessionSelect(state);
  paintForgeWording(state);
  paintCompareForm(state);
  renderReviewChanges(state);
  persistReviewTabs();
  applyPanel();
  renderTabs();
  paintReviewPane(state);
  if (state.mode === 'request') void loadMergeRequests(state);
  void loadReviewSessions(state);
}

/** Hide the graph/detail columns and show the request review view. */
export function openReviewTab(): void {
  const existing = store.activeId ? activeTab()?.review : null;
  if (existing) {
    if (store.activeId) activateReviewTab(store.activeId);
    return;
  }
  const state = ensureReviewState('request');
  if (!state) return;
  showReviewPanel(state);
}

/** Hide the graph/detail columns and show the branch-comparison view. */
export function openCompareTab(): void {
  const existing = store.activeId ? activeTab()?.compare : null;
  if (existing) {
    if (store.activeId) activateCompareTab(store.activeId);
    return;
  }
  const state = ensureReviewState('compare');
  if (!state) return;
  showReviewPanel(state);
}

/**
 * Open the comparison panel on one local commit and start its AI review. The
 * base/head pickers keep listing every branch, with the commit and its first
 * parent pinned. Comments are local-only: there is no request to post them to.
 */
export async function openCommitReview(hash: string): Promise<void> {
  const state = ensureReviewState('compare');
  if (!state) return;
  if (state.job?.state === 'running') {
    const proceed = await confirmDialog({
      title: 'Start a commit review?',
      message:
        'A review is running in this tab. Starting a commit review hides it; it keeps ' +
        'running in the background and remains available under Saved reviews.',
      confirmLabel: 'Start commit review',
    });
    if (!proceed) return;
  }
  window.clearTimeout(state.poll);
  window.clearTimeout(state.saveTimer);
  clearReviewTarget(state);
  state.mode = 'compare';
  state.compareHead = hash;
  store.activePanel = { kind: 'review', repoId: state.repoId, mode: 'compare' };
  resetReviewDom();
  refreshSessionSelect(state);
  refreshMrSelect(state);
  paintForgeWording(state);
  paintCompareForm(state);
  renderReviewChanges(state);
  persistReviewTabs();
  applyPanel();
  renderTabs();
  paintReviewPane(state);
  const status = $('#review-status');
  status.textContent = 'Starting commit review…';
  try {
    const { job, changes } = await reviewApi<{ job: ReviewJob; changes: ReviewChanges }>(
      state,
      '/review/generate-commit',
      { hash },
    );
    state.changes = changes;
    state.job = job;
    state.compareBase = changes.commit?.baseHash ?? '';
    state.compareHead = changes.commit?.hash ?? hash;
    rememberStartedSession(state, job);
    state.edits.clear();
    state.showRejected = false;
    state.headWarning = null;
    refreshMrSelect(state);
    paintForgeWording(state);
    paintCompareForm(state);
    renderReviewChanges(state);
    $('#review-approve-mr').hidden = true;
    $('#review-queue-wrap').hidden = true;
    status.textContent = '';
    if (isReviewShown(state)) renderJob(state, job);
    paintReviewPane(state);
    renderTabs();
    window.clearTimeout(state.poll);
    state.poll = window.setTimeout(() => void pollJob(state), 600);
    void loadReviewSessions(state);
  } catch (err) {
    status.textContent = String(err);
  }
}

/** Clear the review view's DOM for a fresh tab. */
export function resetReviewDom(): void {
  $('#review-queue-wrap').hidden = true;
  paintJobControls(null, null);
  $('#review-approve-mr').hidden = true;
  $('#review-warning').hidden = true;
  $('#review-changes').hidden = true;
  $('#review-changes-pane').hidden = true;
  $('#review-comments-pane').hidden = true;
  $('#review-file-list').innerHTML = '';
  $('#review-file-diff').innerHTML = '';
  $<HTMLSelectElement>('#review-mr-select').disabled = false;
  $('#review-refresh-mrs').hidden = false;
  $('#review-checkout-mr').hidden = false;
}

/** Repaint the review view from a tab's stored state when it becomes visible. */
export function paintReview(state: ReviewTabState): void {
  refreshMrSelect(state);
  refreshSessionSelect(state);
  const changes = state.changes;
  paintForgeWording(state);
  paintCompareForm(state);
  renderReviewChanges(state);
  $('#review-approve-mr').hidden = changes === null || !!changes.commit || !!changes.compare;
  $('#review-queue-wrap').hidden = true;
  paintJobControls(state, state.job);
  $('#review-status').textContent = '';
  paintReviewWarning(state);
  if (state.job) renderJob(state, state.job);
  paintReviewPane(state);
  autosizeCommentBodies($('#review-view'));
}

/** Close a repository's review tab and, if it was visible, fall back to the graph. */
export function closeReviewTab(repoId: string, mode: 'request' | 'compare' = 'request'): void {
  const tab = store.tabs.find((t) => t.id === repoId);
  const state = mode === 'compare' ? tab?.compare : tab?.review;
  if (!tab || !state) return;
  window.clearTimeout(state.poll);
  window.clearTimeout(state.saveTimer);
  // Only the visible tab owns mounted excerpt editors; drop them on close.
  const wasShown = isReviewShown(state);
  if (wasShown) disposeExcerptEditors();
  if (mode === 'compare') tab.compare = null;
  else tab.review = null;
  if (wasShown) {
    const other = mode === 'compare' ? tab.review : tab.compare;
    if (other) {
      store.activePanel = { kind: 'review', repoId: tab.id, mode: other.mode };
      applyPanel();
      paintReview(other);
    } else {
      store.activePanel = { kind: 'graph' };
      applyPanel();
      renderCached();
    }
  }
  renderTabs();
  persistReviewTabs();
}

export function initReview(): void {
  initReviewFileResizer();
  window.addEventListener('pagehide', flushReviewEdits);

  // The graph context menu asks for a single-commit review through this event,
  // avoiding a static import cycle between the two UI modules.
  window.addEventListener('liana-review-commit', (ev) => {
    const hash = (ev as CustomEvent<unknown>).detail;
    if (typeof hash === 'string' && hash) void openCommitReview(hash);
  });

  // The graph context menu's "Compare with current branch" entry.
  window.addEventListener('liana-review-compare', (ev) => {
    const detail = (ev as CustomEvent<{ base?: unknown; head?: unknown }>).detail;
    const base = typeof detail?.base === 'string' ? detail.base : '';
    const head = typeof detail?.head === 'string' ? detail.head : '';
    if (base && head) void openCompareReview(base, head);
  });

  // Text can reflow when the window narrows; re-grow comment bodies so their
  // full text stays visible without an inner scrollbar.
  let resizeTimer: number | undefined;
  window.addEventListener('resize', () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      const state = activeReview();
      if (state && isReviewShown(state)) autosizeCommentBodies($('#review-view'));
    }, 120);
  });

  $('#btn-review').addEventListener('click', () => {
    closeMoreMenu();
    openReviewTab();
  });

  $('#btn-compare').addEventListener('click', () => {
    closeMoreMenu();
    openCompareTab();
  });

  $('#review-refresh-mrs').addEventListener('click', () => {
    const state = activeReview();
    if (state) void loadMergeRequests(state);
  });

  $('#review-mr-select').addEventListener('change', () => {
    const state = activeReview();
    if (!state) return;
    window.clearTimeout(state.poll);
    void loadSelectedMr(true);
  });

  $('#review-generate').addEventListener('click', () => {
    const state = activeReview();
    if (!state) return;
    if (state.mode === 'compare') void generateCompareReview(state);
    else void generateReview();
  });

  document.querySelectorAll<HTMLButtonElement>('.review-subtab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const state = activeReview();
      if (!state) return;
      const pane = btn.dataset.reviewPane === 'comments' ? 'comments' : 'changes';
      if (state.reviewPane === pane) return;
      state.reviewPane = pane;
      paintReviewPane(state);
    });
  });

  $('#review-checkout-mr').addEventListener('click', () => void checkoutMrBranch());
  $('#review-compare-run').addEventListener('click', () => {
    const state = activeReview();
    if (state) void runCompare(state);
  });

  $('#review-compare-swap').addEventListener('click', () => {
    const state = activeReview();
    if (!state) return;
    const base = state.compareBase;
    state.compareBase = state.compareHead;
    state.compareHead = base;
    paintCompareForm(state);
  });

  $('#review-compare-base').addEventListener('change', () => {
    const state = activeReview();
    if (!state) return;
    state.compareBase = $<HTMLSelectElement>('#review-compare-base').value;
    paintCompareForm(state);
  });

  $('#review-compare-head').addEventListener('change', () => {
    const state = activeReview();
    if (!state) return;
    state.compareHead = $<HTMLSelectElement>('#review-compare-head').value;
    paintCompareForm(state);
  });

  document.querySelectorAll<HTMLButtonElement>('.review-diff-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const state = activeReview();
      if (!state) return;
      state.diffLayout = btn.dataset.diffLayout === 'split' ? 'split' : 'unified';
      writeDiffView(state.diffLayout);
      renderReviewFileDiff(state);
      document.querySelectorAll<HTMLButtonElement>('.review-diff-btn').forEach((other) => {
        const active = other.dataset.diffLayout === state.diffLayout;
        other.classList.toggle('is-active', active);
        other.setAttribute('aria-pressed', String(active));
      });
    });
  });

  $('#review-file-list').addEventListener('click', (ev) => {
    const target = ev.target;
    if (!(target instanceof HTMLElement)) return;
    const row = target.closest<HTMLElement>('.review-file-row');
    if (!row) return;
    const state = activeReview();
    const key = row.dataset.file ?? '';
    if (state && key) selectReviewFile(state, key);
  });

  $('#review-diff-prev').addEventListener('click', () => {
    const state = activeReview();
    if (state) jumpReviewDiff(state, -1);
  });

  document.addEventListener(
    'keydown',
    (ev) => {
      if ($<HTMLDialogElement>('#diff-dialog').open) return;
      if (!(ev.ctrlKey || ev.metaKey)) return;
      if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return;
      const state = activeReview();
      if (!state || !isReviewShown(state) || state.reviewPane !== 'changes') return;
      const target = ev.target;
      if (
        target instanceof HTMLElement &&
        !target.closest('.monaco-editor') &&
        target.closest('input, textarea, [contenteditable="true"]')
      ) {
        return;
      }
      ev.preventDefault();
      jumpReviewDiff(state, ev.key === 'ArrowUp' ? -1 : 1);
    },
    true,
  );
  $('#review-diff-next').addEventListener('click', () => {
    const state = activeReview();
    if (state) jumpReviewDiff(state, 1);
  });

  // The batch/step progress line is the model-log trigger: clicking it (or
  // pressing Enter/Space on it) opens the log for the current job.
  $('#review-progress').addEventListener('click', () => {
    const state = activeReview();
    if (!state?.job) return;
    renderReviewLog(state, state.job);
    $<HTMLDialogElement>('#review-log-dialog').showModal();
  });

  // `toggle` does not bubble, so listen in the capture phase to lazily load a
  // call's prompt/response the first time each part is expanded.
  $('#review-log-timeline').addEventListener(
    'toggle',
    (ev) => {
      const target = ev.target;
      if (!(target instanceof HTMLDetailsElement)) return;
      if (target.classList.contains('review-log-batch-group')) {
        const batch = Number(target.dataset.batch);
        if (!Number.isInteger(batch)) return;
        if (target.open) logOpenBatches.add(batch);
        else logOpenBatches.delete(batch);
        return;
      }
      if (!target.classList.contains('review-log-part')) return;
      const index = Number(target.dataset.idx);
      const part = target.dataset.part;
      if (!Number.isInteger(index) || (part !== 'prompt' && part !== 'response')) return;
      const key = `${index}:${part}`;
      if (target.open) {
        logOpenParts.add(key);
        const state = logRenderState;
        const job = state?.job;
        if (state && job) void fillLogStep(state, job, index, job.prompts[index]?.segments ?? []);
      } else {
        logOpenParts.delete(key);
      }
    },
    true,
  );

  // Resume a batch from a logged step: delete the later steps of that batch and
  // re-enter the agent there, after confirming. Later batches are kept.
  $('#review-log-timeline').addEventListener('click', (ev) => {
    const target = ev.target;
    if (!(target instanceof HTMLElement)) return;
    const btn = target.closest('.review-log-resume-step');
    if (!(btn instanceof HTMLButtonElement)) return;
    const state = logRenderState;
    const job = state?.job;
    if (!state || !job) return;
    const index = Number(btn.dataset.idx);
    const prompt = job.prompts[index];
    if (!Number.isInteger(index) || !prompt) return;
    if (job.state === 'running') {
      $('#review-status').textContent = 'Pause the review before resuming from a step.';
      return;
    }
    void (async () => {
      const ok = await confirmDialog({
        title: 'Resume from this step?',
        message:
          `The later steps of batch ${prompt.batchIndex} will be deleted and the batch ` +
          're-run from this step. Later batches are kept and resume at their last step.',
        confirmLabel: 'Resume',
        danger: true,
      });
      if (!ok) return;
      const status = $('#review-status');
      status.textContent = 'Resuming from step…';
      try {
        const { job: next } = await reviewApi<{ job: ReviewJob }>(state, '/review/resume-step', {
          jobId: job.id,
          index,
        });
        state.job = next;
        applyCommentEdits(state, next.comments);
        window.clearTimeout(state.poll);
        resetReviewLogCaches();
        $<HTMLDialogElement>('#review-log-dialog').close();
        if (isReviewShown(state)) renderJob(state, next);
        renderTabs();
        status.textContent = '';
        state.poll = window.setTimeout(() => void pollJob(state), 600);
      } catch (err) {
        status.textContent = String(err);
      }
    })();
  });

  $('#review-log-close').addEventListener('click', (ev) => {
    ev.preventDefault();
    $<HTMLDialogElement>('#review-log-dialog').close();
  });

  $('#review-session-select').addEventListener('change', () => {
    const state = activeReview();
    if (!state) return;
    const id = $<HTMLSelectElement>('#review-session-select').value;
    if (id) void restoreSession(state, id);
  });

  $('#review-refresh-sessions').addEventListener('click', () => {
    const state = activeReview();
    if (state) void loadReviewSessions(state);
  });

  $('#review-delete-session').addEventListener('click', () => {
    const state = activeReview();
    if (!state?.job) return;
    const id = state.job.id;
    void reviewApi(state, '/review/session/delete', { sessionId: id })
      .then(() => {
        clearReviewTarget(state);
        refreshSessionSelect(state);
        renderReviewChanges(state);
        paintForgeWording(state);
        paintCompareForm(state);
        $('#review-queue-wrap').hidden = true;
        paintJobControls(state, null);
        $('#review-status').textContent = 'Saved review deleted.';
        renderTabs();
        void loadReviewSessions(state);
      })
      .catch((err) => {
        $('#review-status').textContent = String(err);
      });
  });

  $('#review-pause-job').addEventListener('click', () => {
    const state = activeReview();
    if (!state?.job) return;
    void reviewApi<{ paused: boolean }>(state, '/review/pause', { jobId: state.job.id })
      .then(({ paused }) => {
        if (paused && state.job) {
          state.job.state = 'paused';
          window.clearTimeout(state.poll);
          renderJob(state, state.job);
          renderTabs();
          void loadReviewSessions(state);
        }
      })
      .catch((err) => {
        $('#review-status').textContent = String(err);
      });
  });

  $('#review-resume-job').addEventListener('click', () => {
    const state = activeReview();
    if (!state?.job) return;
    const status = $('#review-status');
    status.textContent = 'Resuming…';
    void reviewApi<{ job: ReviewJob }>(state, '/review/resume', { jobId: state.job.id })
      .then(({ job }) => {
        state.job = job;
        applyCommentEdits(state, job.comments);
        status.textContent = '';
        renderJob(state, job);
        renderTabs();
        window.clearTimeout(state.poll);
        state.poll = window.setTimeout(() => void pollJob(state), 600);
      })
      .catch((err) => {
        status.textContent = String(err);
      });
  });

  $('#review-cancel-job').addEventListener('click', () => {
    const state = activeReview();
    if (!state?.job) return;
    void reviewApi(state, '/review/cancel', { jobId: state.job.id })
      .then(() => {
        window.clearTimeout(state.poll);
        if (state.job) state.job.state = 'cancelled';
        paintJobControls(state, state.job);
        renderTabs();
        $('#review-status').textContent = 'Review cancelled.';
      })
      .catch((err) => {
        $('#review-status').textContent = String(err);
      });
  });

  $('#review-toggle-rejected').addEventListener('click', () => {
    const state = activeReview();
    if (!state) return;
    state.showRejected = !state.showRejected;
    renderCommentQueue(state);
  });

  $('#review-approve-mr').addEventListener('click', (ev) => {
    ev.preventDefault();
    const state = activeReview();
    if (!state?.changes) return;
    const changes = state.changes;
    const status = $('#review-status');
    void (async () => {
      if (!(await confirmApprove(state))) return;
      status.textContent = 'Approving…';
      try {
        await reviewApi(state, '/forge/approve', { iid: changes.mr.iid });
        const long = forgeLabels(changes.forge).long;
        status.textContent = `${long.charAt(0).toUpperCase() + long.slice(1)} approved.`;
      } catch (err) {
        status.textContent = String(err);
      }
    })();
  });

  // Escape closes an open dialog, otherwise clears the selection.
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    if (!$('#search-panel').hidden) {
      closeSearch();
      return;
    }
    if (!moreMenu.hidden) {
      closeMoreMenu();
      return;
    }
    if (!statusHistory.hidden) {
      closeStatusHistory();
      return;
    }
    if (!contextMenu.hidden) {
      closeContextMenu();
      return;
    }
    const commitDlg = $<HTMLDialogElement>('#commit-dialog');
    const rebaseDlg = $<HTMLDialogElement>('#rebase-dialog');
    const nameDlg = $<HTMLDialogElement>('#name-dialog');
    const resetDlg = $<HTMLDialogElement>('#reset-dialog');
    const approveDlg = $<HTMLDialogElement>('#approve-dialog');
    const confirmDlg = $<HTMLDialogElement>('#confirm-dialog');
    const cherryPickDlg = $<HTMLDialogElement>('#cherry-pick-dialog');
    const stashDlg = $<HTMLDialogElement>('#stash-dialog');
    const aboutDlg = $<HTMLDialogElement>('#about-dialog');
    const diffDlg = $<HTMLDialogElement>('#diff-dialog');
    const conflictDlg = $<HTMLDialogElement>('#conflict-dialog');
    const aiConflictDlg = $<HTMLDialogElement>('#ai-conflict-dialog');
    const submoduleDlg = $<HTMLDialogElement>('#submodule-log-dialog');
    const reviewLogDlg = $<HTMLDialogElement>('#review-log-dialog');
    const settingsDlg = $<HTMLDialogElement>('#settings-dialog');
    const codeDlg = $<HTMLDialogElement>('#code-dialog');
    if (codeDlg.open) {
      codeDlg.close();
      return;
    }
    if (settingsDlg.open) {
      settingsDlg.close();
      return;
    }
    if (reviewLogDlg.open) {
      reviewLogDlg.close();
      return;
    }
    if (submoduleDlg.open) {
      submoduleDlg.close();
      return;
    }
    if (aiConflictDlg.open) {
      invalidateAiConflict();
      aiConflictDlg.close();
      return;
    }
    if (conflictDlg.open) {
      conflictDlg.close();
      return;
    }
    if (diffDlg.open) {
      diffDlg.close();
      return;
    }
    if (aboutDlg.open) {
      aboutDlg.close();
      return;
    }
    if (resetDlg.open) {
      resetDlg.close();
      return;
    }
    if (approveDlg.open) {
      approveDlg.close();
      return;
    }
    if (confirmDlg.open) {
      confirmDlg.close();
      return;
    }
    if (cherryPickDlg.open) {
      cherryPickDlg.close();
      return;
    }
    if (stashDlg.open) {
      stashDlg.close();
      return;
    }
    if (nameDlg.open) {
      nameDlg.close();
      return;
    }
    if (rebaseDlg.open) {
      rebaseDlg.close();
      return;
    }
    if (commitDlg.open) {
      commitDlg.close();
      return;
    }
    if (store.selectedHash === null) return;
    store.selectedHash = null;
    renderCached();
  });
}
