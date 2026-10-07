// Modal diff viewer: Monaco with an HTML fallback, plus layout toggle state.

import { api } from './api-client';
import { loadCode } from './code-loader';
import { renderDiffBody } from './diff-render';
import { $ } from './dom';
import { store } from './store';
import { CodeHandle } from '../code';
import { FileContents } from '../types';

/** Diff layout preference for the modal viewer. */
export type DiffView = 'unified' | 'split';

export const DIFF_VIEW_KEY = 'liana-diff-view';

export function readDiffView(): DiffView {
  return localStorage.getItem(DIFF_VIEW_KEY) === 'split' ? 'split' : 'unified';
}

/** Cached patch for the currently open file, so toggling layout needn't refetch. */
export let diffPatch = '';

export let diffView: DiffView = 'unified';

/** Active Monaco diff handle, or null while the HTML fallback is in use. */
export let diffHandle: CodeHandle | null = null;

/** Dispose the open Monaco diff editor, if any (called when the dialog closes). */
export function disposeDiffEditor(): void {
  diffHandle?.dispose();
  diffHandle = null;
}

/** Mirror `diffView` onto the toggle buttons. */
export function syncDiffToggle(): void {
  document.querySelectorAll<HTMLButtonElement>('.diff-view-btn').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.view === diffView);
    b.setAttribute('aria-pressed', String(b.dataset.view === diffView));
  });
}

/** Repaint the open dialog body (Monaco toggles in place; HTML re-renders). */
export function renderDiffDialog(): void {
  syncDiffToggle();
  if (diffHandle) {
    diffHandle.setSideBySide(diffView === 'split');
    return;
  }
  const body = $<HTMLDivElement>('#diff-body');
  body.classList.toggle('is-split', diffView === 'split');
  body.classList.remove('is-code');
  body.innerHTML = renderDiffBody(diffPatch, diffView);
}

/** Mount the Monaco diff editor into `#diff-body`; false when Monaco is unavailable. */
export async function mountMonacoDiff(original: string, modified: string, path: string): Promise<boolean> {
  const code = await loadCode();
  if (!code) return false;
  const body = $<HTMLDivElement>('#diff-body');
  disposeDiffEditor();
  body.innerHTML = '';
  body.classList.remove('is-split');
  body.classList.add('is-code');
  diffHandle = code.createDiffEditor(body, original, modified, {
    path,
    sideBySide: diffView === 'split',
  });
  return true;
}

/**
 * Open the modal diff viewer for one file. Prefers Monaco (full original/modified
 * text from `/file-content`); when Monaco can't load, falls back to the unified /
 * split HTML renderer fed by the patch routes.
 */
export async function openCodeDiff(opts: {
  path: string;
  oldPath: string;
  hash: string | null;
  subtitle: string;
}): Promise<void> {
  const dlg = $<HTMLDialogElement>('#diff-dialog');
  const body = $<HTMLDivElement>('#diff-body');
  $('#diff-title').textContent = opts.path;
  $('#diff-subtitle').textContent = opts.subtitle;
  $('#diff-status').textContent = '';
  disposeDiffEditor();
  diffPatch = '';
  diffView = readDiffView();
  body.classList.remove('is-split', 'is-code');
  body.textContent = 'Loading diff…';
  syncDiffToggle();
  dlg.showModal();
  try {
    const contents = await api<FileContents>('/file-content', {
      hash: opts.hash,
      path: opts.path,
      oldPath: opts.oldPath || null,
    });
    if (contents.binary) {
      body.textContent = '';
      body.classList.remove('is-code');
      body.innerHTML = '<div class="dl-note">Binary content — no textual diff.</div>';
      return;
    }
    const mounted = await mountMonacoDiff(contents.original ?? '', contents.modified ?? '', opts.path);
    if (mounted) return;
    // Monaco unavailable: fall back to the patch-based HTML renderer.
    const { patch } = await api<{ patch: string }>(
      opts.hash ? '/commit-file-diff' : '/worktree-file-diff',
      opts.hash
        ? { hash: opts.hash, path: opts.path, oldPath: opts.oldPath || null }
        : { path: opts.path, oldPath: opts.oldPath || null },
    );
    diffPatch = patch;
    renderDiffDialog();
  } catch (err) {
    diffPatch = '';
    body.textContent = '';
    $('#diff-status').textContent = String(err);
  }
}

/** Open the diff viewer for a file in the selected commit. */
export function openDiffDialog(path: string, oldPath: string): void {
  const commit = (store.lastResponse?.commits ?? []).find((c) => c.hash === store.selectedHash);
  if (!commit) return;
  const renamed = oldPath && oldPath !== path ? `${oldPath} → ` : '';
  void openCodeDiff({
    path,
    oldPath,
    hash: commit.hash,
    subtitle: `${renamed}${path} · commit ${commit.hash.slice(0, 8)}`,
  });
}

/** Open the diff viewer for a working-tree file from the commit dialog. */
export function openWorktreeDiff(path: string, oldPath: string): void {
  const renamed = oldPath && oldPath !== path ? `${oldPath} → ` : '';
  void openCodeDiff({ path, oldPath, hash: null, subtitle: `${renamed}${path} · working tree` });
}

export function initDiffView(): void {
  $('#diff-close').addEventListener('click', (ev) => {
    ev.preventDefault();
    disposeDiffEditor();
    $<HTMLDialogElement>('#diff-dialog').close();
  });

  // Dispose Monaco editors on any close path (button or Escape's native cancel).
  $<HTMLDialogElement>('#diff-dialog').addEventListener('close', () => disposeDiffEditor());

  // Unified / split layout toggle; the choice persists across opens.
  document.querySelectorAll<HTMLButtonElement>('.diff-view-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.view === 'split' ? 'split' : 'unified';
      if (next === diffView) return;
      diffView = next;
      try {
        localStorage.setItem(DIFF_VIEW_KEY, diffView);
      } catch {
        // localStorage may be unavailable; the dialog still works in-session.
      }
      renderDiffDialog();
    });
  });

  // Keep the split panes' scroll in step on both axes.
  $<HTMLDivElement>('#diff-body').addEventListener(
    'scroll',
    (ev) => {
      const source = ev.target;
      if (!(source instanceof HTMLElement)) return;
      if (!source.classList.contains('dl-split-pane')) return;
      const body = $<HTMLDivElement>('#diff-body');
      body.querySelectorAll<HTMLElement>('.dl-split-pane').forEach((pane) => {
        if (pane === source) return;
        if (pane.scrollTop !== source.scrollTop) pane.scrollTop = source.scrollTop;
        if (pane.scrollLeft !== source.scrollLeft) pane.scrollLeft = source.scrollLeft;
      });
    },
    true,
  );
}

/** Set the cached patch (used by the subproject placeholder in conflicts.ts). */
export function setDiffPatch(patch: string): void {
  diffPatch = patch;
}

/** Set the active diff layout (used by the subproject placeholder). */
export function setDiffView(view: DiffView): void {
  diffView = view;
}
