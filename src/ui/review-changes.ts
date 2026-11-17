// Changed-files list and inline diff pane for the Code review view. Reused by
// forge requests, single-commit reviews, and local branch comparisons.

import { reviewApi } from './api-client';
import { loadCode } from './code-loader';
import { $ } from './dom';
import { esc } from './format';
import { renderDiffBody } from './diff-render';
import type { ReviewTabState } from './store';
import type { CodeHandle } from '../code';
import type { FileContents, ReviewFile } from '../types';

/** Stable list key for a changed file. */
function fileKey(file: ReviewFile): string {
  return file.newPath || file.oldPath;
}

/** Single-letter status derived from the file flags. */
function fileStatus(file: ReviewFile): string {
  if (file.newFile) return 'A';
  if (file.deletedFile) return 'D';
  if (file.renamedFile) return 'R';
  return 'M';
}

function summary(state: ReviewTabState): string {
  const changes = state.changes;
  if (!changes) return '';
  const compare = changes.compare;
  if (compare) {
    const sep = compare.mode === 'merge-base' ? '...' : '..';
    const counts =
      compare.ahead > 0 || compare.behind > 0
        ? ` · head ${compare.ahead} ahead / ${compare.behind} behind`
        : '';
    const base = compare.mergeBaseSha && compare.mode === 'merge-base'
      ? ` · merge base ${compare.mergeBaseSha.slice(0, 8)}`
      : '';
    return `${compare.baseRef}${sep}${compare.headRef}${counts}${base}`;
  }
  if (changes.commit) return `Commit ${changes.commit.shortHash}`;
  return changes.mr.title;
}


/** Diff scroll containers: one for unified, the two panes for split. */
function diffScrollers(): HTMLElement[] {
  const body = $('#review-file-diff');
  const panes = [...body.querySelectorAll<HTMLElement>('.dl-split-pane')];
  return panes.length > 0 ? panes : [body];
}

/** Hunks grouped per scroll container (same indices across split panes). */
function diffHunks(): HTMLElement[][] {
  const body = $('#review-file-diff');
  const panes = [...body.querySelectorAll<HTMLElement>('.dl-split-pane')];
  if (panes.length > 0) {
    return panes.map((pane) => [...pane.querySelectorAll<HTMLElement>('.dl-hunk')]);
  }
  return [[...body.querySelectorAll<HTMLElement>('.dl-row.dl-hunk')]];
}

function hunkOffset(scroller: HTMLElement, hunk: HTMLElement): number {
  return hunk.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
}

/** Number of diff hunks in one file, cached per changed-file list. */
const hunkCountCache = new WeakMap<ReviewFile[], number[]>();

function fileHunkCount(file: ReviewFile): number {
  if (file.binary || file.isSubmodule || !file.diff) return 0;
  return (file.diff.match(/^@@ /gm) ?? []).length;
}

function hunkCounts(files: ReviewFile[]): number[] {
  let counts = hunkCountCache.get(files);
  if (!counts) {
    counts = files.map(fileHunkCount);
    hunkCountCache.set(files, counts);
  }
  return counts;
}

/** Modified-side start line of each hunk, for Monaco-based navigation. */
const hunkStartCache = new WeakMap<ReviewFile, number[]>();

function hunkStarts(file: ReviewFile): number[] {
  let starts = hunkStartCache.get(file);
  if (!starts) {
    starts = [];
    const re = /^@@ -\d+(?:,\d+)? \+(\d+)/gm;
    let match: RegExpExecArray | null;
    while ((match = re.exec(file.diff)) !== null) {
      const line = Number(match[1]);
      if (Number.isFinite(line)) starts.push(line);
    }
    hunkStartCache.set(file, starts);
  }
  return starts;
}

let diffHandle: CodeHandle | null = null;
let diffMountToken = 0;
const contentCache = new Map<string, FileContents | null>();

/** Dispose the full-file Monaco diff, if mounted. */
function disposeFullDiff(): void {
  diffHandle?.dispose();
  diffHandle = null;
  $('#review-file-diff').classList.remove('is-code');
}

function contentKey(state: ReviewTabState, file: ReviewFile): string | null {
  const refs = state.changes?.diffRefs;
  if (!refs?.headSha) return null;
  return `${state.repoId}\n${refs.baseSha}\n${refs.headSha}\n${file.oldPath}\n${file.newPath}`;
}

/** Load the full original/modified file for the Monaco diff. */
async function loadFullFile(state: ReviewTabState, file: ReviewFile): Promise<FileContents | null> {
  const refs = state.changes?.diffRefs;
  const key = contentKey(state, file);
  if (!refs || !key) return null;
  if (contentCache.has(key)) return contentCache.get(key) ?? null;
  try {
    const contents = await reviewApi<FileContents>(state, '/review-file-content', {
      baseSha: refs.baseSha,
      headSha: refs.headSha,
      path: file.newPath,
      oldPath: file.oldPath || null,
    });
    if (contentCache.size > 40) contentCache.clear();
    contentCache.set(key, contents);
    return contents;
  } catch {
    contentCache.set(key, null);
    return null;
  }
}

/** Mount the full-file (commit-detail-style) Monaco diff when contents exist. */
async function mountFullDiff(
  state: ReviewTabState,
  file: ReviewFile,
  changes: NonNullable<ReviewTabState['changes']>,
  token: number,
): Promise<void> {
  const contents = await loadFullFile(state, file);
  if (token !== diffMountToken || state.changes !== changes || state.selectedFile !== fileKey(file)) {
    return;
  }
  if (!contents || contents.binary) return;
  if (contents.original === null && contents.modified === null) return;
  const code = await loadCode();
  if (!code || token !== diffMountToken) return;
  const body = $('#review-file-diff');
  diffHandle?.dispose();
  body.innerHTML = '';
  body.classList.add('is-code');
  diffHandle = code.createDiffEditor(body, contents.original ?? '', contents.modified ?? '', {
    path: file.newPath,
    sideBySide: state.diffLayout === 'split',
    consumeMouseWheel: false,
  });
  diffHandle.revealFirstDiff();
  if (state.diffHunk >= 0) revealHunk(file, state.diffHunk);
}

/** Scroll/reveal one hunk in the current renderer (Monaco or the HTML patch). */
function revealHunk(file: ReviewFile, hunk: number): void {
  if (diffHandle) {
    const line = hunkStarts(file)[hunk];
    if (line !== undefined) diffHandle.revealLineRange(line, line);
    return;
  }
  scrollToHunk(diffHunks(), hunk);
}

function scrollToHunk(groups: HTMLElement[][], index: number): void {
  const scrollers = diffScrollers();
  scrollers.forEach((scroller, pane) => {
    const hunk = groups[pane]?.[index];
    if (hunk) scroller.scrollTop = Math.max(0, hunkOffset(scroller, hunk) - 8);
  });
}

function paintDiffNav(total: number, cursor: number, onHunk: boolean): void {
  const prev = $<HTMLButtonElement>('#review-diff-prev');
  const next = $<HTMLButtonElement>('#review-diff-next');
  const position = $('#review-diff-position');
  prev.disabled = total === 0 || cursor <= 0;
  next.disabled = total === 0 || cursor >= total - 1;
  position.textContent =
    total === 0 ? '' : onHunk ? `${cursor + 1} / ${total}` : `— / ${total}`;
}

/** The selected file's index in the changed-file list. */
function selectedFileIndex(state: ReviewTabState): number {
  const files = state.changes?.files ?? [];
  const index = files.findIndex((f) => fileKey(f) === state.selectedFile);
  return index >= 0 ? index : 0;
}

function hunksBefore(counts: number[], fileIndex: number): number {
  let total = 0;
  for (let i = 0; i < fileIndex && i < counts.length; i++) total += counts[i] ?? 0;
  return total;
}

/** Normalize the explicit cursor against the current file list. */
function normalizeCursor(
  state: ReviewTabState,
  counts: number[],
): { file: number; hunk: number } {
  const files = state.changes?.files ?? [];
  let file = state.diffFile;
  if (!Number.isInteger(file) || file < 0 || file >= files.length) {
    file = selectedFileIndex(state);
  }
  const count = counts[file] ?? 0;
  let hunk = state.diffHunk;
  if (!Number.isInteger(hunk) || hunk < -1) hunk = -1;
  if (hunk >= count) hunk = count > 0 ? count - 1 : -1;
  state.diffFile = file;
  state.diffHunk = hunk;
  return { file, hunk };
}

/** Repaint the previous/next arrows from the explicit file/hunk cursor. */
export function updateReviewDiffNav(state: ReviewTabState): void {
  const files = state.changes?.files ?? [];
  const counts = files.length > 0 ? hunkCounts(files) : [];
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (total === 0) {
    paintDiffNav(0, 0, false);
    return;
  }
  const { file, hunk } = normalizeCursor(state, counts);
  const before = hunksBefore(counts, file);
  paintDiffNav(total, hunk >= 0 ? before + hunk : before - 1, hunk >= 0);
}

/** Scroll to the previous/next diff hunk, moving across files at the edges. */
export function jumpReviewDiff(state: ReviewTabState, direction: 1 | -1): void {
  const files = state.changes?.files ?? [];
  const counts = files.length > 0 ? hunkCounts(files) : [];
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (total === 0) return;

  const cursor = normalizeCursor(state, counts);
  let file = cursor.file;
  let hunk = cursor.hunk;
  const count = counts[file] ?? 0;

  if (direction > 0) {
    if (hunk >= 0 && hunk + 1 < count) {
      hunk += 1;
    } else if (hunk < 0 && count > 0) {
      hunk = 0;
    } else {
      let next = file + 1;
      while (next < files.length && (counts[next] ?? 0) === 0) next += 1;
      if (next >= files.length) {
        updateReviewDiffNav(state);
        return;
      }
      file = next;
      hunk = 0;
    }
  } else if (hunk > 0) {
    hunk -= 1;
  } else {
    let prev = file - 1;
    while (prev >= 0 && (counts[prev] ?? 0) === 0) prev -= 1;
    if (prev < 0) {
      updateReviewDiffNav(state);
      return;
    }
    file = prev;
    hunk = (counts[prev] ?? 0) - 1;
  }

  state.diffFile = file;
  state.diffHunk = hunk;
  const target = files[file];
  if (!target) return;
  const changedFile = fileKey(target) !== state.selectedFile;
  state.selectedFile = fileKey(target);
  if (changedFile) {
    renderReviewChanges(state);
  } else {
    if (hunk >= 0) revealHunk(target, hunk);
    updateReviewDiffNav(state);
  }
}

/** Keep the selected row's long path scrolled to reveal its file name. */
function revealSelectedFileName(): void {
  const path = document.querySelector<HTMLElement>(
    '.review-file-row.is-active .review-file-path',
  );
  if (path) path.scrollLeft = path.scrollWidth;
}

/** Repaint the file list, its summary, and the selected file's diff. */
export function renderReviewChanges(state: ReviewTabState): void {
  const section = $('#review-changes');
  const changes = state.changes;
  if (!changes) {
    section.hidden = true;
    $('#review-file-list').innerHTML = '';
    $('#review-file-diff').innerHTML = '';
    paintDiffNav(0, 0, false);
    return;
  }
  if (state.diffFor !== changes) {
    state.diffFor = changes;
    state.diffFile = 0;
    state.diffHunk = -1;
    state.selectedFile = null;
  }
  section.hidden = false;
  $('#review-changes-count').textContent = `(${changes.files.length})`;
  $('#review-changes-summary').textContent = summary(state);
  if (changes.files.length === 0) {
    state.selectedFile = null;
    state.diffFile = 0;
    state.diffHunk = -1;
    $('#review-file-list').innerHTML = '<li class="review-file-empty muted">No changed files.</li>';
    $('#review-file-diff').innerHTML = '<div class="dl-note">No changes between these refs.</div>';
    paintDiffNav(0, 0, false);
    return;
  }

  const keys = changes.files.map(fileKey);
  if (!state.selectedFile || !keys.includes(state.selectedFile)) {
    state.selectedFile = keys[0] ?? null;
    state.diffFile = 0;
    state.diffHunk = -1;
  }

  const list = $('#review-file-list');
  list.innerHTML = changes.files
    .map((file) => {
      const key = fileKey(file);
      const status = fileStatus(file);
      const path = file.renamedFile && file.oldPath && file.oldPath !== file.newPath
        ? `${esc(file.oldPath)} → ${esc(file.newPath)}`
        : esc(file.newPath || file.oldPath);
      const flags = [
        file.isSubmodule ? '<span class="review-file-flag">submodule</span>' : '',
        file.binary ? '<span class="review-file-flag">binary</span>' : '',
      ].join('');
      return (
        `<li><button type="button" class="review-file-row${key === state.selectedFile ? ' is-active' : ''}" ` +
        `data-file="${esc(key)}">` +
        `<span class="review-file-status status-${status.toLowerCase()}">${status}</span>` +
        `<span class="review-file-path" title="${path}">${path}</span>${flags}</button></li>`
      );
    })
    .join('');

  document.querySelectorAll<HTMLButtonElement>('.review-diff-btn').forEach((btn) => {
    const active = btn.dataset.diffLayout === state.diffLayout;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
  renderReviewFileDiff(state);
  revealSelectedFileName();
}

/** Repaint only the selected file's diff (used by the layout toggle). */
export function renderReviewFileDiff(state: ReviewTabState): void {
  const body = $('#review-file-diff');
  diffMountToken += 1;
  const token = diffMountToken;
  disposeFullDiff();
  const changes = state.changes;
  const file = changes?.files.find((f) => fileKey(f) === state.selectedFile);
  if (!file) {
    body.innerHTML = '';
    paintDiffNav(0, 0, false);
    return;
  }
  if (file.isSubmodule) {
    body.innerHTML = '<div class="dl-note">Subproject commit change — no textual diff.</div>';
    updateReviewDiffNav(state);
    return;
  }
  if (file.binary) {
    body.innerHTML = '<div class="dl-note">Binary file — no textual diff.</div>';
    updateReviewDiffNav(state);
    return;
  }
  if (!file.diff.trim()) {
    body.innerHTML = '<div class="dl-note">No textual diff.</div>';
    updateReviewDiffNav(state);
    return;
  }
  body.innerHTML = renderDiffBody(file.diff, state.diffLayout);
  updateReviewDiffNav(state);
  if (state.diffHunk >= 0) scrollToHunk(diffHunks(), state.diffHunk);
  if (changes && state.reviewPane === 'changes') void mountFullDiff(state, file, changes, token);
}

/** Select one file in the list and repaint. */
export function selectReviewFile(state: ReviewTabState, key: string): void {
  const files = state.changes?.files ?? [];
  const counts = files.length > 0 ? hunkCounts(files) : [];
  const index = files.findIndex((f) => fileKey(f) === key);
  state.selectedFile = key;
  state.diffFile = index >= 0 ? index : 0;
  state.diffHunk = index >= 0 && (counts[index] ?? 0) > 0 ? 0 : -1;
  state.diffFor = state.changes;
  renderReviewChanges(state);
}

/** Drag handle for the changed-files sidebar; width persists across sessions. */
export function initReviewFileResizer(): void {
  const FILES_WIDTH_KEY = 'liana-review-files-width';
  const root = document.documentElement;
  let saved = 260;
  try {
    const stored = Number(localStorage.getItem(FILES_WIDTH_KEY));
    if (Number.isFinite(stored) && stored >= 140) saved = stored;
  } catch {
    // localStorage may be unavailable; use the default width.
  }
  root.style.setProperty('--review-files-width', `${saved}px`);

  const resizer = $('#review-file-resizer');
  const list = (): HTMLElement => $('#review-file-list');
  let dragging = false;
  let startX = 0;
  let startWidth = 0;

  const apply = (width: number): void => {
    root.style.setProperty('--review-files-width', `${width}px`);
    revealSelectedFileName();
  };

  resizer.addEventListener('pointerdown', (ev) => {
    dragging = true;
    startX = ev.clientX;
    startWidth = list().getBoundingClientRect().width;
    resizer.setPointerCapture(ev.pointerId);
    document.body.classList.add('is-col-resizing');
    ev.preventDefault();
  });

  resizer.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    const container = resizer.parentElement;
    const max = Math.max(180, (container?.clientWidth ?? 800) - 220);
    const width = Math.max(140, Math.min(max, startWidth + ev.clientX - startX));
    apply(width);
  });

  const stop = (): void => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('is-col-resizing');
    revealSelectedFileName();
    try {
      localStorage.setItem(FILES_WIDTH_KEY, String(Math.round(list().getBoundingClientRect().width)));
    } catch {
      // Best-effort persistence only.
    }
  };
  resizer.addEventListener('pointerup', stop);
  resizer.addEventListener('pointercancel', stop);
  resizer.addEventListener('lostpointercapture', stop);
}

/** Recompute the mounted diff after its pane becomes visible (remount if needed). */
export function layoutReviewDiff(state: ReviewTabState): void {
  if (diffHandle) diffHandle.layout();
  else renderReviewFileDiff(state);
}
