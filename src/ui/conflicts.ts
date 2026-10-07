// Conflict resolution: side-by-side viewer, per-file resolve/save, and submodule history.

import { api } from './api-client';
import { loadCode } from './code-loader';
import { conflictTypeLabel } from './detail';
import { disposeDiffEditor, readDiffView, setDiffPatch, setDiffView } from './diff-view';
import { esc } from './format';
import { $ } from './dom';
import { CodeHandle } from '../code';
import { isoDate } from '../dates';
import { TextDiffLine, diffLines } from '../diff';
import { ConflictFile, GitCommit } from '../types';
import { refresh } from './actions';
import { openAiConflictDialog } from './ai-conflict';

/** Open the modal side-by-side conflict viewer for one unresolved path. */
export async function openConflictDialog(path: string): Promise<void> {
  if (!path) return;
  conflictPath = path;
  const dlg = $<HTMLDialogElement>('#conflict-dialog');
  $('#conflict-title').textContent = path;
  $('#conflict-subtitle').textContent = 'Loading…';
  $('#conflict-body').innerHTML = '';
  $('#conflict-status').textContent = '';
  dlg.showModal();
  try {
    const { file } = await api<{ file: ConflictFile }>('/conflict-file', { path });
    await renderConflictDialog(file);
  } catch (err) {
    $('#conflict-subtitle').textContent = '';
    $('#conflict-status').textContent = String(err);
  }
}

/** One labelled read-only column (Base / Ours / Theirs) for the conflict viewer. */
export function conflictColumn(label: string, side: 'base' | 'ours' | 'theirs', file: ConflictFile): string {
  const present = side === 'base' ? file.hasBase : side === 'ours' ? file.hasOurs : file.hasTheirs;
  const content = side === 'base' ? file.base : side === 'ours' ? file.ours : file.theirs;
  let body: string;
  if (!present) body = '<div class="dl-note">(deleted)</div>';
  else if (file.isBinary) body = '<div class="dl-note">Binary content.</div>';
  else if (content === null) body = '<div class="dl-note">Unavailable.</div>';
  else if (side === 'base' || file.base === null) body = `<pre class="conflict-pre">${esc(content)}</pre>`;
  else body = `<pre class="conflict-pre">${conflictLinesHtml(diffLines(file.base, content))}</pre>`;
  return `<div class="conflict-col conflict-col-${side}">
    <h4>${esc(label)}</h4>
    ${body}
  </div>`;
}

/** Render diff lines as preformatted rows, tinting added / deleted lines. */
export function conflictLinesHtml(lines: TextDiffLine[]): string {
  return lines
    .map((line) => {
      const cls = line.kind === 'add' ? 'dl-add' : line.kind === 'del' ? 'dl-del' : '';
      return `<span class="cl${cls ? ` ${cls}` : ''}">${esc(line.text)}</span>`;
    })
    .join('');
}

// Monaco editors mounted in the conflict dialog. Reference panes are read-only;
// the Result pane is editable and saved back to the working-tree file.
export let conflictHandles: CodeHandle[] = [];

export let conflictResult: CodeHandle | null = null;

export function disposeConflictEditors(): void {
  for (const handle of conflictHandles) handle.dispose();
  conflictHandles = [];
  conflictResult = null;
}

/**
 * Paint the resolve dialog. For textual conflicts a read-only Monaco column is
 * shown for each side plus an editable Result pane seeded from the working-tree
 * file (conflict markers included) whose save writes and stages the file. Binary
 * and gitlink conflicts keep the plain-text columns and cannot be edited.
 */
export async function renderConflictDialog(file: ConflictFile): Promise<void> {
  const oursLabel = file.oursLabel || 'Ours';
  const theirsLabel = file.theirsLabel || 'Theirs';
  $('#conflict-subtitle').textContent =
    conflictTypeLabel(file.type) + (file.isSubmodule ? ' · submodule' : '');
  const editable = !file.isBinary && !file.isSubmodule && file.worktreeAvailable;
  const useMonaco = !file.isBinary && !file.isSubmodule;
  let note: string;
  if (file.isSubmodule) {
    note =
      '<p class="muted hint">Submodule pointer conflict — the columns show each commit id. Liana never merges submodule contents.</p>';
  } else if (editable) {
    note = `<p class="muted hint">${esc(oursLabel)} / ${esc(theirsLabel)} highlight their changes against Base; the Result pane tints the conflict-marker regions. Pick a side, or edit the Result and save — saving writes the working-tree file and stages it.</p>`;
  } else {
    note = `<p class="muted hint">Choose a side to resolve this file; ${esc(oursLabel)} and ${esc(theirsLabel)} are highlighted against Base.</p>`;
  }

  const cols = useMonaco
    ? (['base', 'ours', 'theirs'] as const)
        .map((side) => {
          const label = side === 'base' ? 'Base' : side === 'ours' ? oursLabel : theirsLabel;
          const present =
            side === 'base' ? file.hasBase : side === 'ours' ? file.hasOurs : file.hasTheirs;
          const content = side === 'base' ? file.base : side === 'ours' ? file.ours : file.theirs;
          const body =
            !present || content === null
              ? '<div class="dl-note">(deleted)</div>'
              : `<div class="code-host" data-side="${side}"></div>`;
          return `<div class="conflict-col conflict-col-${side}">
            <h4>${esc(label)}</h4>
            ${body}
          </div>`;
        })
        .join('')
    : conflictColumn('Base', 'base', file) +
      conflictColumn(oursLabel, 'ours', file) +
      conflictColumn(theirsLabel, 'theirs', file);

  const result = editable
    ? `<div class="conflict-result">
        <h4>Result — edit to resolve</h4>
        <div class="code-host" id="conflict-result-host"></div>
      </div>`
    : '';

  disposeConflictEditors();
  $('#conflict-body').innerHTML =
    note + `<div class="conflict-columns">${cols}</div>` + result;
  $<HTMLButtonElement>('#conflict-ours').textContent = `Use ${oursLabel}`;
  $<HTMLButtonElement>('#conflict-theirs').textContent = `Use ${theirsLabel}`;
  $<HTMLButtonElement>('#conflict-ours').disabled = !file.hasOurs;
  $<HTMLButtonElement>('#conflict-theirs').disabled = !file.hasTheirs;
  $<HTMLButtonElement>('#conflict-save').disabled = !editable;
  $<HTMLButtonElement>('#conflict-ai-fix').disabled = file.isSubmodule || file.isBinary;

  if (!useMonaco) return;
  const code = await loadCode();
  if (!code) return; // Monaco unavailable: plain-text columns remain (no Result editor).
  const body = $<HTMLDivElement>('#conflict-body');
  for (const side of ['base', 'ours', 'theirs'] as const) {
    const host = body.querySelector<HTMLElement>(`.code-host[data-side="${side}"]`);
    if (!host) continue;
    const content = side === 'base' ? file.base : side === 'ours' ? file.ours : file.theirs;
    // Mark Ours / Theirs against Base with an inline read-only diff; Base is plain.
    if (side !== 'base' && file.base !== null && content !== null) {
      conflictHandles.push(
        code.createDiffEditor(host, file.base, content, { path: file.path, sideBySide: false }),
      );
    } else {
      conflictHandles.push(code.createEditor(host, content ?? '', { path: file.path, readOnly: true }));
    }
  }
  // Keep the Base / Ours / Theirs panes' scroll in step on both axes. The
  // editable Result pane stays independent. The guard stops the echo when we
  // programmatically move the sibling editors.
  let syncing = false;
  for (const handle of conflictHandles) {
    handle.onDidScroll(() => {
      if (syncing) return;
      syncing = true;
      try {
        const { top, left } = handle.getScrollPosition();
        for (const other of conflictHandles) {
          if (other !== handle) other.setScrollPosition(top, left);
        }
      } finally {
        syncing = false;
      }
    });
  }
  if (editable) {
    const host = body.querySelector<HTMLElement>('#conflict-result-host');
    if (host) {
      conflictResult = code.createEditor(host, file.worktree ?? '', {
        path: file.path,
        readOnly: false,
        conflictMarkers: true,
      });
    }
  }
}

// --- Conflict resolution dialog ---

/** Path the open conflict dialog refers to, so its buttons can resolve it. */
export let conflictPath = '';

export async function resolveFromDialog(resolution: 'ours' | 'theirs'): Promise<void> {
  const path = conflictPath;
  if (!path) return;
  try {
    await api('/conflict-resolve', { path, resolution });
    disposeConflictEditors();
    $<HTMLDialogElement>('#conflict-dialog').close();
    await refresh();
  } catch (err) {
    $('#conflict-status').textContent = String(err);
  }
}

/** Save the edited Result pane back to the working-tree file and stage it. */
export async function saveConflictFromDialog(): Promise<void> {
  const path = conflictPath;
  if (!path || !conflictResult) return;
  try {
    await api('/conflict-save', { path, content: conflictResult.getValue() });
    disposeConflictEditors();
    $<HTMLDialogElement>('#conflict-dialog').close();
    await refresh();
  } catch (err) {
    $('#conflict-status').textContent = String(err);
  }
}

/** Show a gitlink change as "Subproject commit …" instead of a line diff. */
export function openSubprojectDialog(path: string): void {
  const dlg = $<HTMLDialogElement>('#diff-dialog');
  const body = $<HTMLDivElement>('#diff-body');
  disposeDiffEditor();
  $('#diff-title').textContent = path;
  $('#diff-subtitle').textContent = 'Submodule (gitlink) change';
  $('#diff-status').textContent = '';
  setDiffPatch('');
  body.classList.remove('is-split', 'is-code');
  body.innerHTML =
    '<div class="dl-note">Subproject commit — the recorded gitlink changed. Liana does not diff submodule contents; open the submodule\'s History to browse it.</div>';
  setDiffView(readDiffView());
  dlg.showModal();
}

/** One graph node list (rendered as a simple table) for a submodule's history. */
export function renderSubmoduleHistory(commits: GitCommit[]): string {
  if (commits.length === 0) return '<div class="dl-note">No commits in this submodule.</div>';
  const rows = commits
    .map(
      (c) => `<div class="sub-log-row">
        <code class="sub-log-hash">${esc(c.hash.slice(0, 8))}</code>
        <span class="sub-log-subject" title="${esc(c.subject)}">${esc(c.subject)}</span>
        <span class="sub-log-author">${esc(c.author)}</span>
        <span class="sub-log-date">${isoDate(c.timestamp)}</span>
      </div>`,
    )
    .join('');
  return `<div class="sub-log">${rows}</div>`;
}

/** Open the read-only history of a submodule in a dialog. */
export async function openSubmoduleHistory(path: string): Promise<void> {
  if (!path) return;
  const dlg = $<HTMLDialogElement>('#submodule-log-dialog');
  $('#submodule-log-title').textContent = `Submodule: ${path}`;
  $('#submodule-log-subtitle').textContent = 'Loading…';
  $('#submodule-log-body').innerHTML = '';
  dlg.showModal();
  try {
    const { commits } = await api<{ commits: GitCommit[] }>('/submodule-log', { path });
    $('#submodule-log-subtitle').textContent = `${commits.length} commit(s) · read-only`;
    $('#submodule-log-body').innerHTML = renderSubmoduleHistory(commits);
  } catch (err) {
    $('#submodule-log-subtitle').textContent = '';
    $('#submodule-log-body').innerHTML = `<div class="dl-note">${esc(String(err))}</div>`;
  }
}

export function initConflicts(): void {
  $<HTMLDialogElement>('#conflict-dialog').addEventListener('close', () => disposeConflictEditors());

  $('#conflict-close').addEventListener('click', (ev) => {
    ev.preventDefault();
    disposeConflictEditors();
    $<HTMLDialogElement>('#conflict-dialog').close();
  });

  $('#conflict-ours').addEventListener('click', () => void resolveFromDialog('ours'));

  $('#conflict-theirs').addEventListener('click', () => void resolveFromDialog('theirs'));

  $('#conflict-save').addEventListener('click', () => void saveConflictFromDialog());

  $('#conflict-ai-fix').addEventListener('click', () => {
    $<HTMLDialogElement>('#conflict-dialog').close();
    void openAiConflictDialog(conflictPath);
  });

  // Keep the Base / Ours / Theirs columns' scroll in step on both axes.
  $<HTMLDivElement>('#conflict-body').addEventListener(
    'scroll',
    (ev) => {
      const source = ev.target;
      if (!(source instanceof HTMLElement)) return;
      if (!source.classList.contains('conflict-pre')) return;
      const body = $<HTMLDivElement>('#conflict-body');
      body.querySelectorAll<HTMLElement>('.conflict-pre').forEach((pre) => {
        if (pre === source) return;
        if (pre.scrollTop !== source.scrollTop) pre.scrollTop = source.scrollTop;
        if (pre.scrollLeft !== source.scrollLeft) pre.scrollLeft = source.scrollLeft;
      });
    },
    true,
  );

  $('#submodule-log-close').addEventListener('click', (ev) => {
    ev.preventDefault();
    $<HTMLDialogElement>('#submodule-log-dialog').close();
  });
}
