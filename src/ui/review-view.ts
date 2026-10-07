// Code review main view: one tab per repository, MR/session state, jobs, and comments.

import { reviewApi } from './api-client';
import { copyToClipboard } from './clipboard';
import { loadCode } from './code-loader';
import { esc, gutter } from './format';
import { renderCached } from './graph-view';
import { ReviewTabState, activeTab, store } from './store';
import { activateReviewTab, renderTabs } from './tabs';
import { toast } from './toast';
import { $ } from './dom';
import { CodeHandle } from '../code';
import { DiffLine, parsePatch } from '../diff';
import { ForgeKind, ReviewChanges, ReviewComment, ReviewCommentStatus, ReviewJob, ReviewRequest, ReviewSession, ReviewSessionView } from '../types';
import { invalidateAiConflict } from './ai-conflict';
import { closeContextMenu, contextMenu } from './context-menu';
import { closeMoreMenu, moreMenu } from './more-menu';
import { closeSearch } from './search';
import { closeStatusHistory, statusHistory } from './status-bar';

/** The review tab currently shown, if any. */
export function activeReview(): ReviewTabState | null {
  return store.activeReviewId !== null ? store.reviewTabs.get(store.activeReviewId) ?? null : null;
}

export const reviewView = $('#review-view');

export const REVIEW_TABS_KEY = 'liana-review-tabs';

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

/** Update the review toolbar wording (merge request vs pull request) for a tab. */
export function paintForgeWording(state: ReviewTabState): void {
  if (store.activeReviewId !== state.repoId) return;
  const { short, long } = forgeLabels(state.changes?.forge);
  $('#review-mr-label').textContent = long.charAt(0).toUpperCase() + long.slice(1);
  $('#review-approve-mr').textContent = `Approve ${short}`;
}

/** Remember the open review store.tabs (by path) and which one was visible. */
export function persistReviewTabs(): void {
  try {
    const paths = store.tabs.filter((t) => store.reviewTabs.has(t.id)).map((t) => t.path);
    localStorage.setItem(REVIEW_TABS_KEY, JSON.stringify(paths));
    const active = store.activeReviewId !== null ? store.reviewTabs.get(store.activeReviewId) : undefined;
    if (active) localStorage.setItem(REVIEW_ACTIVE_KEY, active.repoPath);
    else localStorage.removeItem(REVIEW_ACTIVE_KEY);
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

/** Best-effort flush of comment edits for every review tab when the page goes away. */
export function flushReviewEdits(): void {
  for (const state of store.reviewTabs.values()) {
    if (!state.job) continue;
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

export function refreshSessionSelect(state: ReviewTabState): void {
  const sel = $<HTMLSelectElement>('#review-session-select');
  const current = state.job?.id ?? '';
  sel.innerHTML =
    '<option value="">— Saved reviews —</option>' +
    state.sessions
      .map(
        (s) =>
          `<option value="${esc(s.id)}"${s.id === current ? ' selected' : ''}>` +
          `${requestNumber(s.forge, s.iid)} ${esc(s.title)} — ${esc(s.state)}${s.commentCount > 0 ? ` (${s.commentCount})` : ''}</option>`,
      )
      .join('');
  $<HTMLButtonElement>('#review-delete-session').toggleAttribute('disabled', !current);
}

export async function loadReviewSessions(state: ReviewTabState): Promise<void> {
  try {
    const { sessions } = await reviewApi<{ sessions: ReviewSession[] }>(state, '/review/sessions');
    state.sessions = sessions;
    if (store.activeReviewId === state.repoId) refreshSessionSelect(state);
  } catch {
    // A failed listing leaves the previous picker contents in place.
  }
}

/** Restore a persisted session (or a live paused job) into the review view. */
export async function restoreSession(state: ReviewTabState, sessionId: string): Promise<void> {
  if (!sessionId) return;
  const status = $('#review-status');
  if (store.activeReviewId === state.repoId) status.textContent = 'Restoring review…';
  window.clearTimeout(state.poll);
  try {
    const view = await reviewApi<ReviewSessionView>(state, '/review/session', { sessionId });
    applySessionView(state, view);
    if (view.job.state === 'running') {
      state.poll = window.setTimeout(() => void pollJob(state), 600);
    }
    if (store.activeReviewId === state.repoId) refreshSessionSelect(state);
  } catch (err) {
    if (store.activeReviewId === state.repoId) status.textContent = String(err);
  }
}

/** Push a loaded session into the review view's state and DOM. */
export function applySessionView(state: ReviewTabState, view: ReviewSessionView): void {
  state.changes = view.changes;
  state.job = view.job;
  // Keep the MR picker in step with the session it belongs to, even when the
  // request is no longer open (refreshMrSelect renders it as an extra option).
  state.mrIid = view.changes.mr.iid;
  state.edits.clear();
  state.showRejected = false;
  for (const c of view.job.comments) {
    state.edits.set(c.id, { body: c.body, status: c.status });
  }
  if (store.activeReviewId !== state.repoId) return;
  paintForgeWording(state);
  refreshMrSelect(state);
  $('#review-subtitle').textContent = `${requestNumber(view.changes.forge, view.changes.mr.iid)}: ${view.changes.mr.title} — ${view.changes.files.length} file(s)`;
  $('#review-approve-mr').hidden = false;
  renderJob(state, view.job);
  if (view.job.comments.length === 0) $('#review-queue-wrap').hidden = true;
}

export function refreshMrSelect(state: ReviewTabState): void {
  const sel = $<HTMLSelectElement>('#review-mr-select');
  const listed = state.mrs.some((m) => m.iid === state.mrIid);
  // A session may target a request that is no longer open (closed/merged);
  // pin it as an extra option so the picker still reflects the restored MR.
  const pinned =
    state.mrIid > 0 && !listed && state.changes ? state.changes.mr : undefined;
  sel.innerHTML =
    (pinned
      ? `<option value="${pinned.iid}">${requestNumber(state.changes?.forge, pinned.iid)} ${esc(pinned.title)} — (not open)</option>`
      : '') +
    state.mrs
      .map(
        (m) =>
          `<option value="${m.iid}">${requestNumber(state.changes?.forge, m.iid)} ${esc(m.draft ? 'Draft: ' : '')}${esc(m.title)} — ${esc(m.sourceBranch)}→${esc(m.targetBranch)}</option>`,
      )
      .join('');
  // Restore this tab's selection when it exists (listed or pinned), else default.
  if (state.mrIid > 0 && (listed || pinned)) {
    sel.value = String(state.mrIid);
  } else {
    state.mrIid = Number(sel.value) || 0;
  }
  $<HTMLButtonElement>('#review-generate').toggleAttribute('disabled', state.mrs.length === 0);
}

export async function loadMergeRequests(state: ReviewTabState): Promise<void> {
  const status = $('#review-status');
  // Never clobber a restored session's status (e.g. "paused") with MR-list noise.
  if (store.activeReviewId === state.repoId && !state.job) status.textContent = 'Loading requests…';
  try {
    const { mrs } = await reviewApi<{ mrs: ReviewRequest[] }>(state, '/forge/mrs');
    state.mrs = mrs;
    if (store.activeReviewId !== state.repoId) return;
    refreshMrSelect(state);
    if (!state.job) status.textContent = mrs.length === 0 ? 'No open requests.' : '';
  } catch (err) {
    if (store.activeReviewId !== state.repoId) return;
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
    state.job = null;
    state.edits.clear();
    state.showRejected = false;
    // A tab switch landed while this was in flight — the state is updated but
    // the DOM belongs to another review now.
    if (store.activeReviewId !== state.repoId) return true;
    refreshSessionSelect(state);
    paintForgeWording(state);
    $('#review-subtitle').textContent = `${requestNumber(changes.forge, changes.mr.iid)}: ${changes.mr.title} — ${changes.files.length} file(s)`;
    $('#review-queue-wrap').hidden = true;
    $('#review-progress').hidden = true;
    $('#review-cancel-job').hidden = true;
    $('#review-approve-mr').hidden = false;
    $<HTMLButtonElement>('#review-show-log').disabled = true;
    status.textContent = fetchResult?.error
      ? `Request commit not fetched: ${fetchResult.error} — repository tools may be limited`
      : '';
    return true;
  } catch (err) {
    status.textContent = String(err);
    return false;
  }
}

/** Render a job's agent trace and raw model output into the model-log dialog. */
export function renderReviewLog(job: ReviewJob): void {
  $('#review-log-subtitle').textContent = `Step ${job.trace.length} · batch ${job.batchIndex}/${job.batchTotal}${
    job.protocol ? ` · ${job.protocol}` : ''
  }`;
  $('#review-log-trace-count').textContent = String(job.trace.length);
  const ol = $('#review-log-trace');
  ol.innerHTML =
    job.trace.length === 0
      ? '<li class="muted">No tool calls yet.</li>'
      : job.trace
          .map(
            (t) =>
              `<li><code>${esc(t.tool)}</code> <span class="muted">${esc(JSON.stringify(t.args))}</span>` +
              `<div class="trace-result">${esc(t.resultSummary)}</div>` +
              `<span class="muted">${t.durationMs}ms</span></li>`,
          )
          .join('');
  $('#review-log-prompt-count').textContent = String(job.prompts.length);
  const prompts = $('#review-log-prompts');
  // The job is polled continuously, so this runs repeatedly; keep expanded
  // entries open and the scroll position stable across re-renders.
  const openIdx = new Set<number>();
  prompts.querySelectorAll<HTMLDetailsElement>('details[data-idx]').forEach((d) => {
    if (d.open) openIdx.add(Number(d.dataset.idx));
  });
  const scrollTop = prompts.scrollTop;
  prompts.innerHTML =
    job.prompts.length === 0
      ? '<p class="muted">No prompt sent yet.</p>'
      : job.prompts
          .map(
            (p, i) =>
              `<details data-idx="${i}"${openIdx.has(i) ? ' open' : ''}><summary>Step ${p.step} · ${p.chars} chars${p.truncated ? ' · truncated' : ''}</summary>` +
              `<pre>${esc(p.text)}</pre></details>`,
          )
          .join('');
  prompts.scrollTop = scrollTop;
  const out = $<HTMLPreElement>('#review-log-output');
  out.textContent = job.output || '(no output captured yet)';
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

/**
 * Locate a comment's anchor in its file diff and build a small old/new window
 * around it. Returns null when the file, its diff, or the anchor can't be found.
 */
export function excerptWindow(state: ReviewTabState, c: ReviewComment): ExcerptWindow | null {
  if (c.oldLine === null && c.newLine === null) return null;
  const file = state.changes?.files.find((f) => f.newPath === c.filePath || f.oldPath === c.filePath);
  if (!file || !file.diff) return null;
  const lines = parsePatch(file.diff)
    .flatMap((s) => s.hunks)
    .flatMap((h) => h.lines);
  let anchor = -1;
  if (c.newLine !== null) anchor = lines.findIndex((l) => l.newNo === c.newLine);
  if (anchor < 0 && c.oldLine !== null) anchor = lines.findIndex((l) => l.oldNo === c.oldLine);
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
  const file = state.changes?.files.find((f) => f.newPath === c.filePath || f.oldPath === c.filePath);
  const lines = file ? parsePatch(file.diff).flatMap((s) => s.hunks).flatMap((h) => h.lines) : [];
  let anchor = -1;
  if (c.newLine !== null) anchor = lines.findIndex((l) => l.newNo === c.newLine);
  if (anchor < 0 && c.oldLine !== null) anchor = lines.findIndex((l) => l.oldNo === c.oldLine);
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

/** Monaco diff editors mounted for the visible review excerpts. */
export let excerptHandles: CodeHandle[] = [];

/** Tear down every mounted excerpt editor (called before each queue rebuild). */
export function disposeExcerptEditors(): void {
  for (const handle of excerptHandles) handle.dispose();
  excerptHandles = [];
}

/**
 * Upgrade each rendered excerpt placeholder to an inline Monaco diff. Remounts
 * on every queue rebuild, so previous handles are disposed first. When Monaco is
 * unavailable the placeholder's hand-rolled HTML stays in place.
 */
export async function mountExcerptEditors(state: ReviewTabState, list: HTMLElement): Promise<void> {
  disposeExcerptEditors();
  const hosts = list.querySelectorAll<HTMLElement>('.review-comment-excerpt[data-excerpt]');
  if (hosts.length === 0) return;
  const code = await loadCode();
  if (!code) return;
  for (const host of hosts) {
    const id = host.dataset.excerpt ?? '';
    const c = state.job?.comments.find((x) => x.id === id);
    if (!c) continue;
    const win = excerptWindow(state, c);
    if (!win) continue;
    host.classList.add('is-code');
    host.innerHTML = '';
    const mount = document.createElement('div');
    mount.className = 'code-host';
    mount.style.height = `${win.height}px`;
    host.appendChild(mount);
    excerptHandles.push(
      code.createDiffEditor(mount, win.original, win.modified, {
        path: c.filePath,
        sideBySide: false,
        lineNumbers: { original: win.originalLines, modified: win.modifiedLines },
        anchors: win.anchors,
      }),
    );
  }
}

export function renderCommentQueue(state: ReviewTabState): void {
  const job = state.job;
  if (!job || job.comments.length === 0) {
    $('#review-queue-wrap').hidden = true;
    return;
  }
  $('#review-queue-wrap').hidden = false;
  // Re-apply local edits/approvals so a poll snapshot never clobbers typing.
  for (const c of job.comments) {
    const edit = state.edits.get(c.id);
    if (edit) {
      c.body = edit.body;
      c.status = edit.status;
    }
  }
  const total = job.comments.length;
  const pending = job.comments.filter((c) => c.stage === 'pending').length;
  const rejected = job.comments.filter((c) => c.status === 'rejected').length;
  $('#review-queue-count').textContent = pending > 0 ? `(${total}, ${pending} scanning…)` : `(${total})`;
  const toggle = $<HTMLButtonElement>('#review-toggle-rejected');
  toggle.hidden = rejected === 0;
  toggle.textContent = state.showRejected ? 'Hide rejected' : `Show rejected (${rejected})`;
  const visible = job.comments.filter((c) => state.showRejected || c.status !== 'rejected');
  const list = $('#review-comment-list');
  list.innerHTML =
    visible.length === 0
      ? '<p class="muted review-comment-empty">All comments rejected.</p>'
      : visible
          .map((c) => {
            const line =
              c.newLine !== null
                ? `new line ${c.newLine}`
                : c.oldLine !== null
                  ? `old line ${c.oldLine}`
                  : 'general';
            const stage = c.stage === 'pending' ? '<span class="review-stage-badge">scanning…</span>' : '';
            return `
    <div class="review-comment-card${c.stage === 'pending' ? ' is-pending' : ''}" data-id="${esc(c.id)}">
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
        <button type="button" class="btn review-comment-approve" data-id="${esc(c.id)}">Approve</button>
        <button type="button" class="btn review-comment-reject" data-id="${esc(c.id)}">Reject</button>
      </div>
    </div>`;
          })
          .join('');
  for (const ta of list.querySelectorAll<HTMLTextAreaElement>('.review-comment-body')) {
    ta.addEventListener('input', () => {
      const id = ta.dataset.id ?? '';
      const c = state.job?.comments.find((x) => x.id === id);
      if (c) c.body = ta.value;
      const edit = state.edits.get(id) ?? { body: '', status: 'pending' as ReviewCommentStatus };
      edit.body = ta.value;
      state.edits.set(id, edit);
      window.clearTimeout(state.saveTimer);
      state.saveTimer = window.setTimeout(() => void persistSessionEdits(state), 800);
    });
  }
  for (const btn of list.querySelectorAll<HTMLButtonElement>('.review-comment-approve')) {
    btn.addEventListener('click', () => void approveComment(state, btn.dataset.id ?? ''));
  }
  for (const btn of list.querySelectorAll<HTMLButtonElement>('.review-comment-reject')) {
    btn.addEventListener('click', () => void rejectComment(state, btn.dataset.id ?? ''));
  }
  // Upgrade the excerpt placeholders to inline Monaco diffs (no-op if unavailable).
  if (store.activeReviewId === state.repoId) void mountExcerptEditors(state, list);
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
  const c = state.job?.comments.find((x) => x.id === id);
  if (!c || c.status === 'posted' || state.sending.has(id)) return;
  state.sending.add(id);
  setCommentStatus(state, c, 'approved');
  if (store.activeReviewId === state.repoId) renderCommentQueue(state);
  void persistSessionEdits(state);
  try {
    await sendComment(state, id);
  } finally {
    state.sending.delete(id);
    if (store.activeReviewId === state.repoId) renderCommentQueue(state);
  }
}

/** Reject a comment: mark it and hide it from the queue. */
export function rejectComment(state: ReviewTabState, id: string): void {
  const c = state.job?.comments.find((x) => x.id === id);
  if (!c) return;
  setCommentStatus(state, c, 'rejected');
  if (store.activeReviewId === state.repoId) renderCommentQueue(state);
  void persistSessionEdits(state);
}

/** Post a single approved comment and fold the result back into the queue. */
export async function sendComment(state: ReviewTabState, id: string): Promise<void> {
  const job = state.job;
  const changes = state.changes;
  if (!job || !changes) return;
  const c = job.comments.find((x) => x.id === id);
  if (!c) return;
  const status = $('#review-status');
  const shown = store.activeReviewId === state.repoId;
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
    if (store.activeReviewId === state.repoId) {
      renderCommentQueue(state);
      status.textContent =
        c.status === 'posted' ? 'Comment posted.' : `Post failed: ${c.error ?? 'unknown error'}`;
    }
    void persistSessionEdits(state);
  } catch (err) {
    if (shown) status.textContent = String(err);
  }
}

export function renderJob(state: ReviewTabState, job: ReviewJob): void {
  $('#review-progress').hidden = job.state !== 'running';
  $('#review-pause-job').hidden = job.state !== 'running';
  $('#review-resume-job').hidden = job.state !== 'paused';
  $('#review-cancel-job').hidden = job.state !== 'running' && job.state !== 'paused';
  $('#review-progress-text').textContent = `Step ${job.trace.length} · batch ${job.batchIndex}/${job.batchTotal}${
    job.protocol ? ` · ${job.protocol}` : ''
  }`;
  $<HTMLButtonElement>('#review-show-log').disabled = false;
  if ($<HTMLDialogElement>('#review-log-dialog').open) renderReviewLog(job);
  if (job.comments.length > 0) renderCommentQueue(state);
  if (job.state === 'error') {
    $('#review-status').textContent = `Review failed: ${job.error ?? 'unknown error'}`;
  } else if (job.state === 'cancelled') {
    $('#review-status').textContent = 'Review cancelled.';
  } else if (job.state === 'paused') {
    $('#review-status').textContent = 'Review paused — resume to continue.';
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
  try {
    const { job } = await reviewApi<{ job: ReviewJob }>(state, '/review/status', { jobId: state.job.id });
    state.job = job;
    if (store.activeReviewId === state.repoId) renderJob(state, job);
    if (job.state === 'running') {
      state.poll = window.setTimeout(() => void pollJob(state), 800);
    } else {
      void loadReviewSessions(state);
    }
  } catch (err) {
    if (store.activeReviewId === state.repoId) $('#review-status').textContent = String(err);
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
  if (!state) return;
  if (!(await loadSelectedMr(true))) return;
  if (!state.changes) return;
  const status = $('#review-status');
  status.textContent = 'Starting review…';
  try {
    const { job } = await reviewApi<{ job: ReviewJob }>(state, '/review/generate', {
      iid: state.changes.mr.iid,
    });
    state.job = job;
    state.edits.clear();
    state.showRejected = false;
    $('#review-queue-wrap').hidden = true;
    status.textContent = '';
    renderJob(state, job);
    window.clearTimeout(state.poll);
    state.poll = window.setTimeout(() => void pollJob(state), 600);
    void loadReviewSessions(state);
  } catch (err) {
    status.textContent = String(err);
  }
}

/** Hide the graph/detail columns and show the review view for this repository. */
export function openReviewTab(): void {
  // Bind to the active repository; opening review with no repo is a no-op.
  if (!store.activeId) {
    toast('Open a repository first.', 'info');
    return;
  }
  // Re-opening for a repo that already has a review tab focuses it, keeping state.
  if (store.reviewTabs.has(store.activeId)) {
    activateReviewTab(store.activeId);
    return;
  }
  const tab = activeTab();
  if (!tab) return;
  const state: ReviewTabState = {
    repoId: store.activeId,
    repoPath: tab.path,
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
  };
  store.reviewTabs.set(store.activeId, state);
  store.activeReviewId = store.activeId;
  resetReviewDom();
  refreshSessionSelect(state);
  persistReviewTabs();
  updateReviewVisibility();
  renderTabs();
  void loadMergeRequests(state);
  void loadReviewSessions(state);
}

/** Clear the review view's DOM for a fresh tab. */
export function resetReviewDom(): void {
  $('#review-subtitle').textContent = 'Review an open merge/pull request with AI.';
  $('#review-queue-wrap').hidden = true;
  $('#review-progress').hidden = true;
  $('#review-pause-job').hidden = true;
  $('#review-resume-job').hidden = true;
  $('#review-approve-mr').hidden = true;
  $<HTMLButtonElement>('#review-show-log').disabled = true;
}

/** Repaint the review view from a tab's stored state when it becomes visible. */
export function paintReview(state: ReviewTabState): void {
  refreshMrSelect(state);
  refreshSessionSelect(state);
  const changes = state.changes;
  paintForgeWording(state);
  $('#review-subtitle').textContent = changes
    ? `${requestNumber(changes.forge, changes.mr.iid)}: ${changes.mr.title} — ${changes.files.length} file(s)`
    : 'Review an open merge/pull request with AI.';
  $('#review-approve-mr').hidden = changes === null;
  $('#review-queue-wrap').hidden = true;
  $('#review-progress').hidden = true;
  $('#review-pause-job').hidden = true;
  $('#review-resume-job').hidden = true;
  $('#review-cancel-job').hidden = true;
  $('#review-status').textContent = '';
  $<HTMLButtonElement>('#review-show-log').disabled = state.job === null;
  if (state.job) renderJob(state, state.job);
}

/** Close a repository's review tab and, if it was visible, fall back to the graph. */
export function closeReviewTab(repoId: string): void {
  const state = store.reviewTabs.get(repoId);
  if (!state) return;
  window.clearTimeout(state.poll);
  window.clearTimeout(state.saveTimer);
  // Only the visible tab owns mounted excerpt editors; drop them on close.
  if (store.activeReviewId === repoId) disposeExcerptEditors();
  store.reviewTabs.delete(repoId);
  if (store.activeReviewId === repoId) {
    store.activeReviewId = null;
    updateReviewVisibility();
    renderCached();
  }
  renderTabs();
  persistReviewTabs();
}

/** Toggle the columns and the review view to match `store.activeReviewId`. */
export function updateReviewVisibility(): void {
  const shown = store.activeReviewId !== null;
  reviewView.hidden = !shown;
  $('#graph-wrap').hidden = shown;
  $('#detail-resizer').hidden = shown;
  $('#detail-pane').hidden = shown;
  const bound = store.activeReviewId !== null ? store.tabs.find((t) => t.id === store.activeReviewId) : undefined;
  $('#review-repo').textContent = bound ? ` · ${bound.name}` : '';
}

export function initReview(): void {
  window.addEventListener('pagehide', flushReviewEdits);

  $('#btn-review').addEventListener('click', () => {
    closeMoreMenu();
    openReviewTab();
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

  $('#review-generate').addEventListener('click', () => void generateReview());

  $('#review-show-log').addEventListener('click', () => {
    const state = activeReview();
    if (!state?.job) return;
    renderReviewLog(state.job);
    $<HTMLDialogElement>('#review-log-dialog').showModal();
  });

  $('#review-log-copy').addEventListener('click', () => {
    const state = activeReview();
    if (!state?.job) return;
    const trace = state.job.trace
      .map((t) => `${t.tool} ${JSON.stringify(t.args)} → ${t.resultSummary} (${t.durationMs}ms)`)
      .join('\n');
    const prompts = state.job.prompts
      .map((p) => `--- step ${p.step}${p.truncated ? ` (${p.chars} chars, truncated)` : ''} ---\n${p.text}`)
      .join('\n\n');
    const text = [
      state.job.output,
      trace ? `\n\n--- agent trace ---\n${trace}` : '',
      prompts ? `\n\n--- prompts ---\n${prompts}` : '',
    ].join('');
    void copyToClipboard(text).then(() => toast('Model log copied.', 'info'));
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
        window.clearTimeout(state.poll);
        state.job = null;
        state.changes = null;
        state.edits.clear();
        state.showRejected = false;
        refreshSessionSelect(state);
        $('#review-queue-wrap').hidden = true;
        $('#review-progress').hidden = true;
        $('#review-pause-job').hidden = true;
        $('#review-resume-job').hidden = true;
        $('#review-cancel-job').hidden = true;
        $<HTMLButtonElement>('#review-show-log').disabled = true;
        $('#review-status').textContent = 'Saved review deleted.';
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
        status.textContent = '';
        renderJob(state, job);
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
        $('#review-progress').hidden = true;
        $('#review-cancel-job').hidden = true;
        $('#review-pause-job').hidden = true;
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
    const status = $('#review-status');
    status.textContent = 'Approving…';
    void reviewApi(state, '/forge/approve', { iid: state.changes.mr.iid })
      .then(() => {
        const long = forgeLabels(state.changes?.forge).long;
        status.textContent = `${long.charAt(0).toUpperCase() + long.slice(1)} approved.`;
      })
      .catch((err) => {
        status.textContent = String(err);
      });
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
