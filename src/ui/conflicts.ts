// Conflict resolution: side-by-side viewer, per-file resolve/save, and submodule history.

import { api } from './api-client';
import { loadCode } from './code-loader';
import { conflictTypeLabel } from './detail';
import { disposeDiffEditor, readDiffView, setDiffPatch, setDiffView } from './diff-view';
import { esc } from './format';
import { $, $svg } from './dom';
import { CodeHandle } from '../code';
import { ConflictMarkerBlock, parseConflictBlocks } from '../conflict-markers';
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

/** One line picked from a conflict side, remembered in click order. */
interface ConflictChoice {
  side: 'ours' | 'theirs';
  line: number;
  text: string;
}

/** Live picker state for one conflict block in the open Result editor. */
interface ConflictUiState {
  block: ConflictMarkerBlock;
  chosen: ConflictChoice[];
  /** False until the user touches the block, so the Result keeps its markers. */
  touched: boolean;
  /** Decoration-backed range in the Result editor, or null until Monaco creates it. */
  rangeId: string | null;
}

let conflictStates: ConflictUiState[] = [];
let activeConflict = 0;

export function disposeConflictEditors(): void {
  for (const handle of conflictHandles) handle.dispose();
  conflictHandles = [];
  conflictResult = null;
  conflictStates = [];
  activeConflict = 0;
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
  const blocks = editable ? parseConflictBlocks(file.worktree ?? '') : [];
  const showPicker = editable && blocks.length > 0;
  let note: string;
  if (file.isSubmodule) {
    note =
      '<p class="muted hint">Submodule pointer conflict — the columns show each commit id. Liana never merges submodule contents.</p>';
  } else if (editable && showPicker) {
    note = `<p class="muted hint">${esc(oursLabel)} / ${esc(theirsLabel)} highlight their changes against Base. Pick lines from either side below — the Result updates live and stays editable. Unpicked blocks keep their markers; saving writes the working-tree file and stages it.</p>`;
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
  const picker = showPicker ? '<div id="conflict-picker" class="conflict-picker"></div>' : '';
  $('#conflict-body').innerHTML =
    note + `<div class="conflict-columns">${cols}</div>` + result + picker;
  $<HTMLButtonElement>('#conflict-ours').textContent = `Use ${oursLabel}`;
  $<HTMLButtonElement>('#conflict-theirs').textContent = `Use ${theirsLabel}`;
  $<HTMLButtonElement>('#conflict-ours').disabled = !file.hasOurs;
  $<HTMLButtonElement>('#conflict-theirs').disabled = !file.hasTheirs;
  $<HTMLButtonElement>('#conflict-save').disabled = !editable;
  $<HTMLButtonElement>('#conflict-ai-fix').disabled = file.isSubmodule || file.isBinary;

  if (!useMonaco) return;
  const code = await loadCode();
  if (!code) {
    // Monaco unavailable: plain-text columns remain (no Result editor or picker).
    document.getElementById('conflict-picker')?.remove();
    return;
  }
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
  if (showPicker && conflictResult) initConflictPicker(oursLabel, theirsLabel, blocks);
}

// --- Per-conflict line picker ---

/** Build the picker shell; the line lists are filled by refreshConflictPicker. */
function initConflictPicker(
  oursLabel: string,
  theirsLabel: string,
  blocks: ConflictMarkerBlock[],
): void {
  const result = conflictResult;
  if (!result) return;
  conflictStates = blocks.map((block) => ({
    block,
    chosen: [],
    touched: false,
    // Parser lines are 0-based; CodeHandle ranges are 1-based inclusive.
    rangeId: result.trackLineRange(block.startLine + 1, block.endLine),
  }));
  activeConflict = 0;
  const picker = document.getElementById('conflict-picker');
  if (!picker) return;
  picker.innerHTML = `<div class="conflict-picker-head">
    <button type="button" class="icon-btn conflict-nav" data-conflict-nav="prev" title="Previous conflict" aria-label="Previous conflict">↑</button>
    <span class="conflict-picker-count" data-conflict-count></span>
    <button type="button" class="icon-btn conflict-nav" data-conflict-nav="next" title="Next conflict" aria-label="Next conflict">↓</button>
    <span class="conflict-picker-shortcuts">
      <button type="button" class="btn btn-sm" data-conflict-all="ours">All ${esc(oursLabel)}</button>
      <button type="button" class="btn btn-sm" data-conflict-all="theirs">All ${esc(theirsLabel)}</button>
    </span>
  </div>
  <div class="conflict-picker-lines">
    <div class="conflict-picker-side conflict-picker-ours">
      <h5>${esc(oursLabel)}</h5>
      <div class="conflict-picker-list" data-conflict-list="ours"></div>
    </div>
    <div class="conflict-picker-side conflict-picker-theirs">
      <h5>${esc(theirsLabel)}</h5>
      <div class="conflict-picker-list" data-conflict-list="theirs"></div>
    </div>
  </div>`;
  refreshConflictPicker();
  // Reveal the first conflict once the dialog has laid the editor out.
  requestAnimationFrame(() => revealConflict(activeConflict));
}

/** Re-render the current conflict's lines, checked state, and click order badges. */
function refreshConflictPicker(): void {
  const picker = document.getElementById('conflict-picker');
  const state = conflictStates[activeConflict];
  if (!picker || !state) return;
  const count = picker.querySelector<HTMLElement>('[data-conflict-count]');
  if (count) count.textContent = `Conflict ${activeConflict + 1} of ${conflictStates.length}`;
  for (const side of ['ours', 'theirs'] as const) {
    const list = picker.querySelector<HTMLElement>(`[data-conflict-list="${side}"]`);
    if (!list) continue;
    const lines = side === 'ours' ? state.block.ours : state.block.theirs;
    if (lines.length === 0) {
      list.innerHTML = '<div class="conflict-picker-empty">(no lines)</div>';
      continue;
    }
    list.innerHTML = lines
      .map((text, index) => {
        const order = state.chosen.findIndex((c) => c.side === side && c.line === index);
        const on = order >= 0;
        const body =
          text.replace(/\r$/, '') === ''
            ? '<span class="conflict-line-empty">(empty line)</span>'
            : esc(text.replace(/\r$/, ''));
        return `<button type="button" class="conflict-line" data-conflict-side="${side}" data-conflict-line="${index}" aria-pressed="${on}">
          <span class="conflict-line-order">${on ? order + 1 : ''}</span><code>${body}</code>
        </button>`;
      })
      .join('');
  }
}

/** Compute the block's current text and splice it into the Result editor. */
function applyConflictBlock(index: number): void {
  const state = conflictStates[index];
  if (!state || !state.rangeId || !conflictResult) return;
  if (!state.touched) return;
  const text = state.chosen.map((choice) => choice.text).join('\n');
  const nextId = conflictResult.replaceTrackedRange(state.rangeId, text);
  if (nextId) state.rangeId = nextId;
}

/** Toggle one side's line into (or out of) the current conflict's click-ordered choice. */
function toggleConflictLine(side: 'ours' | 'theirs', line: number): void {
  const state = conflictStates[activeConflict];
  if (!state) return;
  const existing = state.chosen.findIndex((c) => c.side === side && c.line === line);
  if (existing >= 0) {
    state.chosen.splice(existing, 1);
  } else {
    const text = (side === 'ours' ? state.block.ours : state.block.theirs)[line];
    if (text === undefined) return;
    state.chosen.push({ side, line, text });
  }
  state.touched = true;
  applyConflictBlock(activeConflict);
  refreshConflictPicker();
}

/** Take every line from one side for the current conflict. */
function selectAllConflictLines(side: 'ours' | 'theirs'): void {
  const state = conflictStates[activeConflict];
  if (!state) return;
  const lines = side === 'ours' ? state.block.ours : state.block.theirs;
  state.chosen = lines.map((text, line) => ({ side, line, text }));
  state.touched = true;
  applyConflictBlock(activeConflict);
  refreshConflictPicker();
}

/** Move the picker to the next/previous conflict and reveal it in the Result. */
function navigateConflict(delta: number): void {
  if (conflictStates.length === 0) return;
  activeConflict = (activeConflict + delta + conflictStates.length) % conflictStates.length;
  refreshConflictPicker();
  revealConflict(activeConflict);
}

/** Scroll the Result editor to a conflict and leave the cursor there for editing. */
function revealConflict(index: number): void {
  const state = conflictStates[index];
  if (!state || !conflictResult) return;
  const tracked = state.rangeId ? conflictResult.getTrackedLineRange(state.rangeId) : null;
  conflictResult.revealLineRange(
    tracked?.startLine ?? state.block.startLine + 1,
    tracked?.endLine ?? state.block.endLine,
  );
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
  // The graph's in-progress-operation node opens the first unresolved path in
  // the manual resolver (the same dialog as a conflict's Compare button).
  $svg('#graph-svg').addEventListener('click', (ev) => {
    const target = ev.target instanceof Element ? ev.target.closest('[data-op]') : null;
    if (!target) return;
    const path = target.getAttribute('data-path') ?? '';
    if (path) void openConflictDialog(path);
  });

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

  // The picker's buttons are regenerated for each conflict, so delegate from the
  // static dialog body rather than binding to the current nodes.
  $<HTMLDivElement>('#conflict-body').addEventListener('click', (ev) => {
    const target =
      ev.target instanceof Element
        ? ev.target.closest('[data-conflict-nav],[data-conflict-all],[data-conflict-side]')
        : null;
    if (!(target instanceof HTMLElement)) return;
    const nav = target.getAttribute('data-conflict-nav');
    if (nav === 'prev' || nav === 'next') {
      navigateConflict(nav === 'prev' ? -1 : 1);
      return;
    }
    const all = target.getAttribute('data-conflict-all');
    if (all === 'ours' || all === 'theirs') {
      selectAllConflictLines(all);
      return;
    }
    const side = target.getAttribute('data-conflict-side');
    const rawLine = target.getAttribute('data-conflict-line');
    if ((side !== 'ours' && side !== 'theirs') || rawLine === null) return;
    const line = Number(rawLine);
    if (Number.isInteger(line)) toggleConflictLine(side, line);
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
