// Conflict resolution: two side panes above an editable Result, plus submodule history.

import { api } from './api-client';
import { loadCode } from './code-loader';
import { conflictTypeLabel } from './detail';
import { disposeDiffEditor, readDiffView, setDiffPatch, setDiffView } from './diff-view';
import { esc } from './format';
import { $, $svg } from './dom';
import { CodeHandle, LineDecoration } from '../code';
import { ConflictMarkerBlock, parseConflictBlocks } from '../conflict-markers';
import { isoDate } from '../dates';
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

/** One labelled read-only side pane (Ours / Theirs) for the no-Monaco fallback. */
export function conflictColumn(
  label: string,
  side: 'ours' | 'theirs',
  file: ConflictFile,
  showControls: boolean,
): string {
  const present = side === 'ours' ? file.hasOurs : file.hasTheirs;
  const content = side === 'ours' ? file.ours : file.theirs;
  let body: string;
  if (!present) body = '<div class="dl-note">(deleted)</div>';
  else if (file.isBinary) body = '<div class="dl-note">Binary content.</div>';
  else if (content === null) body = '<div class="dl-note">Unavailable.</div>';
  else body = `<pre class="conflict-pre" data-conflict-pre="${side}">${esc(content)}</pre>`;
  return `<div class="conflict-col conflict-col-${side}">
    <h4><span>${esc(label)}</span>${showControls ? sideButton(side, label) : ''}</h4>
    ${body}
  </div>`;
}

/** "All <branch>" shortcut shown in a side pane's header. */
function sideButton(side: 'ours' | 'theirs', label: string): string {
  return `<button type="button" class="btn btn-sm" data-conflict-all="${side}">All ${esc(label)}</button>`;
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

/** Full-file line -> conflict block line reference for one side pane. */
interface SideLineRef {
  block: number;
  line: number;
}

type ConflictSide = 'ours' | 'theirs';

let conflictStates: ConflictUiState[] = [];
let activeConflict = 0;
let conflictSideHandles: Partial<Record<ConflictSide, CodeHandle>> = {};
let conflictSideMaps: Record<ConflictSide, Map<number, SideLineRef>> = {
  ours: new Map(),
  theirs: new Map(),
};

export function disposeConflictEditors(): void {
  for (const handle of conflictHandles) handle.dispose();
  conflictHandles = [];
  conflictResult?.dispose();
  conflictResult = null;
  conflictStates = [];
  conflictSideHandles = {};
  conflictSideMaps = { ours: new Map(), theirs: new Map() };
  activeConflict = 0;
}

/** Locate each conflict block's side lines inside the full side file. */
function mapSideLines(
  blocks: ConflictMarkerBlock[],
  text: string | null,
  side: ConflictSide,
): Map<number, SideLineRef> {
  const map = new Map<number, SideLineRef>();
  if (text === null) return map;
  const fileLines = text.split('\n').map((line) => line.replace(/\r$/, ''));
  let cursor = 0;
  for (let b = 0; b < blocks.length; b++) {
    const block = blocks[b]!;
    const wanted = (side === 'ours' ? block.ours : block.theirs).map((line) => line.replace(/\r$/, ''));
    if (wanted.length === 0) continue;
    let found = -1;
    outer: for (let i = cursor; i + wanted.length <= fileLines.length; i++) {
      for (let k = 0; k < wanted.length; k++) {
        if (fileLines[i + k] !== wanted[k]) continue outer;
      }
      found = i;
      break;
    }
    if (found < 0) continue;
    for (let k = 0; k < wanted.length; k++) {
      map.set(found + k + 1, { block: b, line: k });
    }
    cursor = found + wanted.length;
  }
  return map;
}

/**
 * Paint the resolve dialog. For textual conflicts two read-only Monaco panes show
 * each side's full file plus an editable Result pane seeded from the working-tree
 * file (conflict markers included) whose save writes and stages the file. Binary
 * and gitlink conflicts keep the plain-text panes and cannot be edited.
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
      '<p class="muted hint">Submodule pointer conflict — the panes show each commit id. Liana never merges submodule contents.</p>';
  } else if (editable && showPicker) {
    note = `<p class="muted hint">${esc(oursLabel)} and ${esc(theirsLabel)} show each side of the conflict. Click lines in either pane above — the Result updates live and stays editable. Unpicked blocks keep their markers; saving writes the working-tree file and stages it.</p>`;
  } else if (editable) {
    note = `<p class="muted hint">Edit the Result and save, or pick a side, to resolve this file. Saving writes the working-tree file and stages it.</p>`;
  } else {
    note = `<p class="muted hint">Choose a side to resolve this file.</p>`;
  }

  const cols = useMonaco
    ? (['ours', 'theirs'] as const)
        .map((side) => {
          const label = side === 'ours' ? oursLabel : theirsLabel;
          const present = side === 'ours' ? file.hasOurs : file.hasTheirs;
          const content = side === 'ours' ? file.ours : file.theirs;
          const body =
            !present || content === null
              ? '<div class="dl-note">(deleted)</div>'
              : `<div class="code-host" data-side="${side}"></div>`;
          return `<div class="conflict-col conflict-col-${side}">
            <h4><span>${esc(label)}</span>${showPicker ? sideButton(side, label) : ''}</h4>
            ${body}
          </div>`;
        })
        .join('')
    : conflictColumn(oursLabel, 'ours', file, showPicker) +
      conflictColumn(theirsLabel, 'theirs', file, showPicker);

  const result = editable
    ? `<div class="conflict-result">
        <h4>
          <span>Result — edit to resolve</span>
          ${
            showPicker
              ? `<span class="conflict-result-nav">
                  <button type="button" class="icon-btn conflict-nav" data-conflict-nav="prev" title="Previous conflict" aria-label="Previous conflict">↑</button>
                  <span class="conflict-nav-count" data-conflict-count></span>
                  <button type="button" class="icon-btn conflict-nav" data-conflict-nav="next" title="Next conflict" aria-label="Next conflict">↓</button>
                </span>`
              : ''
          }
        </h4>
        <div class="code-host" id="conflict-result-host"></div>
      </div>`
    : '';

  disposeConflictEditors();
  $('#conflict-body').innerHTML =
    note + `<div class="conflict-panels">${cols}${result}</div>`;
  $<HTMLButtonElement>('#conflict-ours').textContent = `Use ${oursLabel}`;
  $<HTMLButtonElement>('#conflict-theirs').textContent = `Use ${theirsLabel}`;
  $<HTMLButtonElement>('#conflict-ours').disabled = !file.hasOurs;
  $<HTMLButtonElement>('#conflict-theirs').disabled = !file.hasTheirs;
  $<HTMLButtonElement>('#conflict-save').disabled = !editable;
  $<HTMLButtonElement>('#conflict-ai-fix').disabled = file.isSubmodule || file.isBinary;

  if (!useMonaco) return;
  const code = await loadCode();
  if (!code) {
    // Monaco unavailable: plain-text panes remain (no Result editor or picking).
    const body = $<HTMLDivElement>('#conflict-body');
    body.querySelectorAll('[data-conflict-all],[data-conflict-nav]').forEach((el) => el.remove());
    return;
  }
  const body = $<HTMLDivElement>('#conflict-body');
  for (const side of ['ours', 'theirs'] as const) {
    const host = body.querySelector<HTMLElement>(`.code-host[data-side="${side}"]`);
    if (!host) continue;
    const content = side === 'ours' ? file.ours : file.theirs;
    const handle = code.createEditor(host, content ?? '', { path: file.path, readOnly: true });
    conflictHandles.push(handle);
    conflictSideHandles[side] = handle;
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
  // Keep all three panes' vertical scroll in step; horizontal stays independent.
  const syncHandles = [...conflictHandles];
  if (conflictResult) syncHandles.push(conflictResult);
  syncVerticalScroll(syncHandles);
  if (showPicker && conflictResult) initConflictPicking(file, blocks);
}

/** Mirror vertical scroll across the panes without echoing the programmatic move. */
function syncVerticalScroll(handles: CodeHandle[]): void {
  let syncing = false;
  for (const handle of handles) {
    handle.onDidScroll(() => {
      if (syncing) return;
      syncing = true;
      try {
        const top = handle.getScrollPosition().top;
        for (const other of handles) {
          if (other !== handle) other.setScrollPosition(top, other.getScrollPosition().left);
        }
      } finally {
        syncing = false;
      }
    });
  }
}

// --- In-panel line picking ---

/** Bind conflict-line picking to the two side panes and seed the Result's ranges. */
function initConflictPicking(file: ConflictFile, blocks: ConflictMarkerBlock[]): void {
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
  conflictSideMaps = {
    ours: mapSideLines(blocks, file.ours, 'ours'),
    theirs: mapSideLines(blocks, file.theirs, 'theirs'),
  };
  for (const side of ['ours', 'theirs'] as const) {
    const handle = conflictSideHandles[side];
    const map = conflictSideMaps[side];
    if (!handle) continue;
    handle.onLineClick((line) => {
      const ref = map.get(line);
      if (!ref) return;
      activeConflict = ref.block;
      toggleConflictLine(ref.block, side, ref.line);
    });
  }
  refreshConflictPicking();
  // Reveal the first conflict once the dialog has laid the editors out.
  requestAnimationFrame(() => revealConflict(activeConflict));
}

/** Update the conflict counter and both side panes' line decorations. */
function refreshConflictPicking(): void {
  const count = document.querySelector<HTMLElement>('[data-conflict-count]');
  if (count) count.textContent = `Conflict ${activeConflict + 1} of ${conflictStates.length}`;
  refreshConflictDecorations();
}

/** Paint pickable, active, and picked lines (with click-order badges) on both sides. */
function refreshConflictDecorations(): void {
  for (const side of ['ours', 'theirs'] as const) {
    const handle = conflictSideHandles[side];
    if (!handle) continue;
    const decorations: LineDecoration[] = [];
    for (const [fileLine, ref] of conflictSideMaps[side]) {
      const classes = ['conflict-panel-line'];
      if (ref.block === activeConflict) classes.push('conflict-panel-active');
      const state = conflictStates[ref.block];
      const order = state ? state.chosen.findIndex((c) => c.side === side && c.line === ref.line) : -1;
      const decoration: LineDecoration = {
        startLine: fileLine,
        endLine: fileLine,
        className: classes.join(' '),
      };
      if (order >= 0) {
        classes.push('conflict-panel-picked');
        decoration.className = classes.join(' ');
        decoration.badge = String(order + 1);
      }
      decorations.push(decoration);
    }
    handle.setLineDecorations(decorations);
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

/** Toggle one side's line into (or out of) a conflict block's click-ordered choice. */
function toggleConflictLine(blockIndex: number, side: 'ours' | 'theirs', line: number): void {
  const state = conflictStates[blockIndex];
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
  applyConflictBlock(blockIndex);
  refreshConflictPicking();
}

/** Take every line from one side for the active conflict. */
function selectAllConflictLines(side: 'ours' | 'theirs'): void {
  const state = conflictStates[activeConflict];
  if (!state) return;
  const lines = side === 'ours' ? state.block.ours : state.block.theirs;
  state.chosen = lines.map((text, line) => ({ side, line, text }));
  state.touched = true;
  applyConflictBlock(activeConflict);
  refreshConflictPicking();
}

/** Move to the next/previous conflict and reveal it in the Result. */
function navigateConflict(delta: number): void {
  if (conflictStates.length === 0) return;
  activeConflict = (activeConflict + delta + conflictStates.length) % conflictStates.length;
  refreshConflictPicking();
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

  // Header controls are regenerated for each file, so delegate from the static
  // dialog body rather than binding to the current nodes.
  $<HTMLDivElement>('#conflict-body').addEventListener('click', (ev) => {
    const target =
      ev.target instanceof Element
        ? ev.target.closest('[data-conflict-nav],[data-conflict-all]')
        : null;
    if (!(target instanceof HTMLElement)) return;
    const nav = target.getAttribute('data-conflict-nav');
    if (nav === 'prev' || nav === 'next') {
      navigateConflict(nav === 'prev' ? -1 : 1);
      return;
    }
    const all = target.getAttribute('data-conflict-all');
    if (all === 'ours' || all === 'theirs') selectAllConflictLines(all);
  });

  // Keep the no-Monaco fallback panes' vertical scroll in step.
  $<HTMLDivElement>('#conflict-body').addEventListener(
    'scroll',
    (ev) => {
      const source = ev.target;
      if (!(source instanceof HTMLElement)) return;
      if (!source.classList.contains('conflict-pre')) return;
      const body = $<HTMLDivElement>('#conflict-body');
      body.querySelectorAll<HTMLElement>('.conflict-pre').forEach((pre) => {
        if (pre !== source && pre.scrollTop !== source.scrollTop) pre.scrollTop = source.scrollTop;
      });
    },
    true,
  );

  $('#submodule-log-close').addEventListener('click', (ev) => {
    ev.preventDefault();
    $<HTMLDialogElement>('#submodule-log-dialog').close();
  });
}
