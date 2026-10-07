// UI entry: wires the graph pane, detail pane, toolbar actions, and dialogs.

import { layoutGraph } from './layout';
import { diffLines, parsePatch, pairHunk, type DiffLine, type DiffSection, type SplitRow, type TextDiffLine } from './diff';
import { EMPTY_METRICS, avatarColor, initials, renderGraph, type GraphHighlight, type GraphMetrics } from './graph';
import { displayRefs, refIconHtml, remoteBranchName } from './refs';
import { isoDate, isoDateTime } from './dates';
import { INTERACTIVE_REBASE_ENABLED } from './config';
import type { CodeHandle } from './code';
import type { AiConflictFix, AiProviderConfig, AppSettings, CommitFile, ConflictEntry, ConflictFile, ConflictType, FileContents, ForgeKind, GitCommandRecord, GitCommit, GitRef, ReviewRequest, ReviewChanges, GraphLayout, MergeOperation, RebaseAction, RebaseTodoItem, RemoteStatus, RepoActivity, RepoState, RepoStatus, ResetMode, ReviewComment, ReviewCommentStatus, ReviewJob, ReviewSession, ReviewSessionView, StatusEntry, SubmoduleInfo } from './types';

/**
 * Monaco is loaded on demand so the editor and its language workers stay out of
 * the initial bundle. The first code view triggers the import; failures fall back
 * to the hand-rolled HTML renderers below. `null` means "tried and unavailable".
 */
type CodeModule = typeof import('./code');
let codeModule: CodeModule | null | undefined;

async function loadCode(): Promise<CodeModule | null> {
  if (codeModule !== undefined) return codeModule;
  try {
    codeModule = await import('./code');
  } catch {
    codeModule = null;
  }
  return codeModule;
}

interface StateResponse {
  configured: boolean;
  repoPath?: string;
  state?: RepoState;
  commits?: GitCommit[];
  status?: RepoStatus;
  conflicts?: ConflictEntry[];
  operation?: MergeOperation;
  submodules?: SubmoduleInfo[];
}

/** A repository open in a tab. Holds per-tab view state so switching is instant. */
interface RepoTab {
  id: string;
  path: string;
  name: string;
  selectedHash: string | null;
  lastResponse: StateResponse | null;
  remoteStatus: RemoteStatus | null;
  panX: number;
  panY: number;
  zoom: number;
}

let tabs: RepoTab[] = [];
let activeId: string | null = null;

let currentLayout: GraphLayout | null = null;
let selectedHash: string | null = null;
let repoName = '';
let lastResponse: StateResponse | null = null;
let remoteStatus: RemoteStatus | null = null;

// Search state, shared across tabs; results are recomputed per repo on every render.
let searchQuery = '';
let searchCurrent: string | null = null;
let searchMatches: SearchMatch[] = [];

// Graph viewport transform: pan offset (px) and zoom scale.
let panX = 0;
let panY = 0;
let zoom = 1;

function activeTab(): RepoTab | undefined {
  return tabs.find((t) => t.id === activeId);
}

/** Copy the live active-tab globals back into the tab record. */
function saveActive(): void {
  const t = activeTab();
  if (!t) return;
  t.selectedHash = selectedHash;
  t.lastResponse = lastResponse;
  t.remoteStatus = remoteStatus;
  t.panX = panX;
  t.panY = panY;
  t.zoom = zoom;
}

/** Make `tab` active and restore its view state into the globals. */
function loadTab(tab: RepoTab): void {
  activeId = tab.id;
  selectedHash = tab.selectedHash;
  lastResponse = tab.lastResponse;
  remoteStatus = tab.remoteStatus;
  panX = tab.panX;
  panY = tab.panY;
  zoom = tab.zoom;
  repoName = tab.name;
  currentLayout = null;
  // The cached activity belongs to the previously active tab.
  activity = null;
  closeStatusHistory();
  applyTransform();
  renderTabs();
  renderStatusBar();
  persistTabs();
}

function applyTransform(): void {
  const svg = document.querySelector('#graph-svg');
  if (!(svg instanceof SVGSVGElement)) return;
  svg.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  svg.style.transformOrigin = '0 0';
}

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el;
};

/** Typed helper: query a single element with a precise DOM type. */
function $svg(sel: string): SVGSVGElement {
  const el = document.querySelector(sel);
  if (!(el instanceof SVGSVGElement)) throw new Error(`missing svg element ${sel}`);
  return el;
}

// --- API helpers ---

interface ApiOpts {
  /** Send the active tab's repository id. Set false for repo-management routes. */
  scoped?: boolean;
  /** Explicit repository id to scope to (used by background review polling). */
  repoId?: string;
}

async function api<T>(route: string, body?: unknown, opts: ApiOpts = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = window.liana?.token;
  if (token) headers['x-liana-token'] = token;
  const scope = opts.repoId ?? activeId;
  if (opts.scoped !== false && scope) headers['x-liana-repo'] = scope;
  const res = await fetch(`/api${route}`, {
    method: body !== undefined ? 'POST' : 'GET',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

/**
 * Review/GitLab calls are scoped to the repository a review tab is bound to,
 * not the active tab, so background polling keeps working after a tab switch.
 */
function reviewApi<T>(state: ReviewTabState, route: string, body?: unknown): Promise<T> {
  return api<T>(route, body, { repoId: state.repoId });
}

// --- Git command status bar ---

/** Last activity snapshot for the active tab, kept so a stale poll can be dropped. */
let activity: RepoActivity | null = null;

/** Format a finished command's duration for the status bar meta. */
function commandMeta(cmd: GitCommandRecord): string {
  const ms = cmd.durationMs ?? 0;
  const time = ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;
  if (cmd.running) return '';
  if (cmd.exitCode === null) return `failed · ${time}`;
  return cmd.exitCode === 0 ? time : `exit ${cmd.exitCode} · ${time}`;
}

/** Paint the status bar from the current `activity` snapshot. */
function renderStatusBar(): void {
  const bar = document.querySelector('#status-bar');
  if (!(bar instanceof HTMLElement)) return;
  const spinner = $('#status-spinner');
  const commandEl = $('#status-command');
  const branchEl = $('#status-branch');
  const metaEl = $('#status-meta');
  const tab = activeTab();

  // Current branch (or detached HEAD) of the active tab, shown left of the command.
  const state = tab?.lastResponse?.state;
  const branch = state
    ? state.detachedHead
      ? 'detached HEAD'
      : state.headBranch ?? ''
    : '';
  branchEl.hidden = !tab || branch === '';
  branchEl.textContent = branch;
  branchEl.title = branch
    ? state?.detachedHead
      ? 'Detached HEAD'
      : `On branch ${branch}`
    : '';

  if (!tab) {
    bar.classList.remove('is-running', 'is-error');
    spinner.hidden = true;
    commandEl.textContent = 'No repository open';
    metaEl.textContent = '';
    return;
  }

  const running = activity?.running ?? null;
  const last = activity?.last ?? null;
  const shown = running ?? last;
  const failed = !running && last !== null && last.failed;

  bar.classList.toggle('is-running', running !== null);
  bar.classList.toggle('is-error', failed);
  spinner.hidden = running === null;
  commandEl.textContent = shown ? shown.display : 'Ready';
  commandEl.title = shown ? shown.display : '';
  metaEl.textContent = running
    ? 'running…'
    : last
      ? commandMeta(last)
      : '';
}

/** Fetch the active tab's git activity and repaint (drops stale cross-tab responses). */
async function refreshActivity(): Promise<void> {
  const reqId = activeId;
  if (!reqId) {
    activity = null;
    renderStatusBar();
    return;
  }
  try {
    const next = await api<RepoActivity>('/activity');
    if (activeId !== reqId) return;
    activity = next;
    renderStatusBar();
    // Keep an open popover live as commands start and finish.
    if (!statusHistory.hidden) renderStatusHistory();
  } catch {
    // Transient (e.g. dev-server restart); keep the previous snapshot.
  }
}

// Poll while anything is running (fast) and idle slowly, so the bar reflects
// external commands too. A command's own API call triggers an immediate refresh.
const ACTIVITY_RUNNING_MS = 250;
const ACTIVITY_IDLE_MS = 1500;
let activityTimer: number | undefined;

function scheduleActivityPoll(): void {
  window.clearTimeout(activityTimer);
  const delay = activity?.active ? ACTIVITY_RUNNING_MS : ACTIVITY_IDLE_MS;
  activityTimer = window.setTimeout(() => {
    void refreshActivity().finally(scheduleActivityPoll);
  }, delay);
}

const statusHistory = $('#status-history');

function closeStatusHistory(): void {
  if (statusHistory.hidden) return;
  statusHistory.hidden = true;
  $('#status-command').setAttribute('aria-expanded', 'false');
}

/** Render the recent-commands popover from the current activity snapshot. */
function renderStatusHistory(): void {
  statusHistory.replaceChildren();
  const entries = activity?.history ?? [];
  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'status-history-empty';
    empty.textContent = 'No commands yet';
    statusHistory.appendChild(empty);
    return;
  }
  for (const cmd of entries) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `status-history-item${cmd.failed ? ' is-failed' : ''}`;
    btn.title = `Copy: ${cmd.display}`;
    const code = document.createElement('code');
    code.textContent = cmd.display;
    const meta = document.createElement('span');
    meta.className = 'status-history-meta';
    meta.textContent = commandMeta(cmd);
    btn.append(code, meta);
    btn.addEventListener('click', () => {
      closeStatusHistory();
      void copyToClipboard(cmd.display);
    });
    statusHistory.appendChild(btn);
  }
}

/** Toggle the recent-commands popover, anchored above the status bar. */
function toggleStatusHistory(): void {
  if (!statusHistory.hidden) {
    closeStatusHistory();
    return;
  }
  renderStatusHistory();
  const bar = $('#status-bar').getBoundingClientRect();
  statusHistory.hidden = false;
  $('#status-command').setAttribute('aria-expanded', 'true');
  // Grow upward from the bar's left edge; the popover width is capped by CSS.
  statusHistory.style.bottom = `${window.innerHeight - bar.top + 6}px`;
  statusHistory.style.top = 'auto';
  statusHistory.style.left = `${Math.max(8, bar.left + 10)}px`;
  statusHistory.style.right = 'auto';
}

$('#status-command').addEventListener('click', () => toggleStatusHistory());

// --- Rendering ---

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Initials avatar markup (shared with the graph's SVG avatars). */
function avatarHtml(name: string, small = false): string {
  return `<span class="avatar${small ? ' avatar-sm' : ''}" style="background:${avatarColor(name)}">${esc(initials(name))}</span>`;
}

/** Map a porcelain status char to a badge class. */
function statusClass(ch: string): string {
  switch (ch) {
    case 'A':
      return 's-add';
    case 'D':
      return 's-del';
    case 'R':
    case 'C':
      return 's-ren';
    case '?':
      return 's-unt';
    default:
      return 's-mod';
  }
}

/** Right-aligned line-number cell, empty when the side has no line. */
function gutter(no: number | null): string {
  return `<span class="dl-no">${no ?? ''}</span>`;
}

/** Render parsed diff sections as a unified (single-column) table. */
function renderUnified(sections: DiffSection[]): string {
  const rows: string[] = [];
  for (const section of sections) {
    for (const line of section.meta) {
      rows.push(`<div class="dl-row dl-meta">${esc(line.text)}</div>`);
    }
    for (const hunk of section.hunks) {
      rows.push(`<div class="dl-row dl-hunk">${esc(hunk.header)}</div>`);
      for (const line of hunk.lines) {
        if (line.kind === 'nonewline') {
          rows.push(`<div class="dl-row dl-nonewline">${esc(line.text)}</div>`);
          continue;
        }
        const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
        rows.push(
          `<div class="dl-row dl-${line.kind}">${gutter(line.oldNo)}${gutter(line.newNo)}<span class="dl-sign">${sign}</span><span class="dl-text">${esc(line.text)}</span></div>`,
        );
      }
    }
  }
  return rows.join('');
}

/** One cell of the split view: line number + text, or a blank filler. */
function splitCell(line: DiffLine | null, side: 'old' | 'new'): string {
  if (!line) return '<div class="dl-cell dl-empty"></div>';
  const no = side === 'old' ? line.oldNo : line.newNo;
  return `<div class="dl-cell dl-${line.kind}">${gutter(no)}<span class="dl-text">${esc(line.text)}</span></div>`;
}

/** Render parsed diff sections as two independent old | new scroll panes. */
function renderSplit(sections: DiffSection[]): string {
  const oldRows: string[] = [];
  const newRows: string[] = [];
  for (const section of sections) {
    for (const line of section.meta) {
      const html = `<div class="dl-meta split-meta">${esc(line.text)}</div>`;
      oldRows.push(html);
      newRows.push(html);
    }
    for (const hunk of section.hunks) {
      const header = `<div class="dl-hunk split-meta">${esc(hunk.header)}</div>`;
      oldRows.push(header);
      newRows.push(header);
      const pairs: SplitRow[] = pairHunk(hunk);
      for (const [left, right] of pairs) {
        oldRows.push(splitCell(left, 'old'));
        newRows.push(splitCell(right, 'new'));
      }
    }
  }
  return (
    `<div class="dl-split">` +
    `<div class="dl-split-pane dl-split-old">${oldRows.join('')}</div>` +
    `<div class="dl-split-pane dl-split-new">${newRows.join('')}</div>` +
    `</div>`
  );
}

/** Render the dialog body for the given layout. */
function renderDiffBody(patch: string, view: DiffView): string {
  const sections = patch ? parsePatch(patch) : [];
  if (sections.length === 0) return '<div class="dl-note">No textual diff.</div>';
  return view === 'split' ? renderSplit(sections) : renderUnified(sections);
}

/** `+N − M` line counts for a changed file, or a binary marker. */
function fileStatHtml(file: CommitFile): string {
  if (file.binary) return '<span class="file-stat binary">bin</span>';
  const add = file.additions ?? 0;
  const del = file.deletions ?? 0;
  let out = '';
  if (add > 0) out += `<span class="file-stat add">+${add}</span>`;
  if (del > 0) out += `<span class="file-stat del">−${del}</span>`;
  return out;
}

/** One-line upstream sync summary shown on the repo overview. */
function syncSummaryHtml(): string {
  const rs = remoteStatus;
  if (!rs) return '';
  if (rs.remotes.length === 0) {
    return '<p class="sync-status muted">No remote configured — add one with <code>git remote add</code> to push or pull.</p>';
  }
  if (!rs.upstream) return '';
  const parts: string[] = [];
  if (rs.ahead > 0) parts.push(`${rs.ahead} ahead`);
  if (rs.behind > 0) parts.push(`${rs.behind} behind`);
  const divergence = parts.length > 0 ? ` · ${parts.join(', ')}` : ' · up to date';
  return `<p class="sync-status"><code>${esc(rs.upstream)}</code>${divergence}</p>`;
}

/** Human label for an operation kind, used in the conflict banner. */
function operationLabel(kind: MergeOperation['kind']): string {
  switch (kind) {
    case 'rebase':
      return 'Rebase';
    case 'merge':
      return 'Merge';
    case 'cherry-pick':
      return 'Cherry-pick';
    case 'revert':
      return 'Revert';
    default:
      return 'Operation';
  }
}

/** Human label for a conflict type. */
function conflictTypeLabel(type: ConflictType): string {
  switch (type) {
    case 'both-modified':
      return 'modified both sides';
    case 'both-added':
      return 'added both sides';
    case 'added-by-us':
      return 'added by us';
    case 'added-by-them':
      return 'added by them';
    case 'deleted-by-us':
      return 'deleted by us';
    case 'deleted-by-them':
      return 'deleted by them';
  }
}

/** Banner listing the in-progress operation and its continue/skip/abort controls. */
function operationBanner(op: MergeOperation): string {
  const label = operationLabel(op.kind);
  const n = op.conflictCount;
  const noun = n === 1 ? 'file' : 'files';
  const detail = n > 0 ? `${n} conflicted ${noun}` : 'all conflicts resolved';
  const skip = op.kind === 'rebase' || op.kind === 'cherry-pick' || op.kind === 'revert';
  return `<div class="conflict-banner">
    <div class="conflict-banner-head">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.2 1.4 13.4h13.2L8 2.2Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M8 6.4v3.2M8 11.6v.01" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      <span><strong>${esc(label)} in progress</strong> — ${detail}</span>
    </div>
    <div class="conflict-banner-actions">
      <button type="button" class="btn btn-primary act" data-act="op-continue"${n > 0 ? ' disabled title="Resolve all files first"' : ''}>Continue</button>
      ${skip ? '<button type="button" class="btn act" data-act="op-skip">Skip</button>' : ''}
      <button type="button" class="btn btn-danger act" data-act="op-abort">Abort</button>
    </div>
  </div>`;
}

/** List of unresolved paths with per-file resolution controls. */
function renderConflicts(conflicts: ConflictEntry[]): string {
  if (conflicts.length === 0) return '';
  const op = lastResponse?.operation;
  const ours = op?.oursLabel || 'Ours';
  const theirs = op?.theirsLabel || 'Theirs';
  let html = '<h4>Conflicts</h4><ul class="conflict-list">';
  for (const c of conflicts) {
    html += `<li class="conflict-item" data-path="${esc(c.path)}">
      <div class="conflict-row">
        <span class="status-badge s-conflict">!</span>
        <span class="status-path" title="${esc(c.path)}">${esc(c.path)}</span>
        <span class="conflict-kind">${conflictTypeLabel(c.type)}${c.isSubmodule ? ' · submodule' : ''}</span>
      </div>
      <div class="conflict-actions">
        <button type="button" class="btn btn-sm act" data-act="view-conflict" data-path="${esc(c.path)}">Compare</button>
        <button type="button" class="btn btn-sm act" data-act="take-ours" data-path="${esc(c.path)}">${esc(ours)}</button>
        <button type="button" class="btn btn-sm act" data-act="take-theirs" data-path="${esc(c.path)}">${esc(theirs)}</button>
        ${c.isSubmodule ? '' : `<button type="button" class="btn btn-sm act" data-act="ai-fix-conflict" data-path="${esc(c.path)}">Fix with AI</button>`}
        <button type="button" class="btn btn-sm act" data-act="mark-resolved" data-path="${esc(c.path)}">Mark resolved</button>
      </div>
    </li>`;
  }
  return html + '</ul>';
}

/** Human label for a submodule state. */
function submoduleStateLabel(s: SubmoduleInfo['status']): string {
  switch (s) {
    case 'current':
      return 'up to date';
    case 'modified':
      return 'new commits';
    case 'uninitialized':
      return 'not initialized';
    case 'conflicted':
      return 'conflicted';
    case 'untracked':
      return 'untracked';
  }
}

/** Submodule panel: each entry with its state and the sanctioned network actions. */
function renderSubmodules(submodules: SubmoduleInfo[]): string {
  if (submodules.length === 0) return '';
  let html = '<h4>Submodules</h4><ul class="submodule-list">';
  for (const s of submodules) {
    const short = s.worktreeHash?.slice(0, 8) ?? s.recordedHash?.slice(0, 8) ?? '';
    const stateClass = s.status === 'current' ? 'sub-ok' : s.status === 'conflicted' ? 'sub-conflict' : 'sub-warn';
    html += `<li class="submodule-item" data-path="${esc(s.path)}">
      <div class="submodule-row">
        <span class="sub-badge ${stateClass}">${esc(submoduleStateLabel(s.status))}</span>
        <span class="status-path" title="${esc(s.path)}">${esc(s.path)}</span>
        ${short ? `<code class="sub-hash">${esc(short)}</code>` : ''}
      </div>
      <div class="submodule-actions">
        <button type="button" class="btn btn-sm act" data-act="sub-log" data-path="${esc(s.path)}">History</button>
        <button type="button" class="btn btn-sm act" data-act="sub-update" data-path="${esc(s.path)}">Update</button>
        <button type="button" class="btn btn-sm act" data-act="sub-sync" data-path="${esc(s.path)}">Sync URL</button>
        <button type="button" class="btn btn-sm act btn-danger" data-act="sub-deinit" data-path="${esc(s.path)}">Deinit</button>
      </div>
    </li>`;
  }
  html += '</ul>';
  html += '<p class="muted hint">Update fetches the recorded commit; Sync rewrites URLs from .gitmodules. Both use git\'s credential helper.</p>';
  return html;
}

function renderDetail(commits: GitCommit[], state: RepoState | undefined, status: RepoStatus | undefined): void {
  const pane = $('#detail-pane');
  const commit = commits.find((c) => c.hash === selectedHash);

  let html = '';
  const operation = lastResponse?.operation;
  const conflicts = lastResponse?.conflicts ?? [];
  if (operation?.inProgress) {
    html += operationBanner(operation);
    html += renderConflicts(conflicts);
  }
  const dirty = status?.entries.length ?? 0;
  if (dirty > 0 && !operation?.inProgress) {
    const noun = dirty === 1 ? 'change' : 'changes';
    html += `<div class="dirty-banner">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.2 1.4 13.4h13.2L8 2.2Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M8 6.4v3.2M8 11.6v.01" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      <span>${dirty} uncommitted ${noun} — commit or stash before rebasing</span>
    </div>`;
  }
  if (!commit) {
    html += '<h3>Repository</h3>';
    if (state) {
      html += `<p class="muted">${esc(repoName)} — ${esc(state.headBranch ?? 'detached HEAD')}</p>`;
      html += syncSummaryHtml();
      if (state.branches.length > 0) {
        html += '<h4>Branches</h4><ul class="branch-list">';
        for (const b of state.branches) {
          const kind = b.isRemote ? 'remote' : 'local';
          const badge = b.isHead ? '<span class="head-badge">HEAD</span>' : '';
          const label = b.isRemote ? remoteBranchName(b.name) : b.name;
          html += `<li class="branch-${kind}" data-branch="${esc(b.name)}" data-remote="${b.isRemote ? 'true' : 'false'}" title="Checkout ${esc(b.name)}">
            ${refIconHtml(kind)}
            <span class="branch-name">${esc(label)}</span>
            ${badge}
          </li>`;
        }
        html += '</ul>';
        html += '<p class="muted hint">Click a branch to checkout</p>';
      }
    }
    if (status && status.entries.length > 0) {
      const staged = status.entries.filter((e) => e.stagedX !== ' ' && e.stagedX !== '?');
      const unstaged = status.entries.filter((e) => e.unstagedY !== ' ' || e.stagedX === '?');
      if (staged.length > 0) {
        html += '<h4>Staged</h4><ul class="status-list">';
        for (const e of staged) {
          html += `<li><span class="status-badge ${statusClass(e.stagedX)}">${esc(e.stagedX)}</span><span class="status-path">${esc(e.path)}</span></li>`;
        }
        html += '</ul>';
      }
      if (unstaged.length > 0) {
        html += '<h4>Unstaged</h4><ul class="status-list">';
        for (const e of unstaged) {
          const code = e.stagedX === '?' ? '??' : e.unstagedY;
          html += `<li><span class="status-badge ${statusClass(e.stagedX === '?' ? '?' : e.unstagedY)}">${esc(code)}</span><span class="status-path">${esc(e.path)}</span></li>`;
        }
        html += '</ul>';
      }
    } else {
      html += '<p class="muted">Working tree clean</p>';
    }
    html += renderSubmodules(lastResponse?.submodules ?? []);
    html += `<div class="detail-empty">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" fill="currentColor"/><path d="M12 2v7M12 15v7M2 12h7M15 12h7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
      <strong>No commit selected</strong>
      <span class="hint">Pick a commit in the graph to see details and actions.</span>
    </div>`;
  } else {
    const short = commit.hash.slice(0, 8);
    html += `<div class="detail-head">
      <div class="detail-title">
        <h3>${esc(commit.subject)}</h3>
        <span class="head-actions">
          <button type="button" class="icon-btn act" data-act="copy-subject" data-copy="${esc(commit.subject)}" title="Copy commit text" aria-label="Copy commit text">
            <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="9" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.5 5.5V3.4A1.4 1.4 0 0 0 9.1 2H3.9A1.4 1.4 0 0 0 2.5 3.4v5.2a1.4 1.4 0 0 0 1.4 1.4h2.1" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
          </button>
          <button type="button" class="icon-btn act" data-act="copy-hash" data-copy="${esc(commit.hash)}" title="Copy commit hash" aria-label="Copy commit hash">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.2 2 4.8 14M11.2 2 9.8 14M2.5 5.6h11M2 10.4h11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
          </button>
        </span>
      </div>`;
    html += `<div class="meta-row">
      <span class="meta-chip">${avatarHtml(commit.author, true)}${esc(commit.author)}</span>
      <span class="meta-chip" title="${esc(isoDateTime(commit.timestamp))}">${esc(isoDateTime(commit.timestamp))}</span>
      <span class="meta-chip"><code>${short}</code></span>
    </div>`;
    if (commit.refs.length > 0) {
      html +=
        '<p class="meta-row">' +
        displayRefs(commit.refs)
          .map(
            (r) =>
              `<span class="ref-pill ref-${r.kind}${r.merged ? ' ref-merged' : ''}" title="${esc(r.title)}">${r.icons.map(refIconHtml).join('')}${esc(r.name)}</span>`,
          )
          .join(' ') +
        '</p>';
    }
    html += '</div>';
    if (commit.isStash) {
      const branch = commit.stash?.branch ? ` (from ${esc(commit.stash.branch)})` : '';
      html += '<div class="actions">';
      html += `<p class="muted hint">Stash entry${branch}. Applying restores the saved changes on the checked-out branch.</p>`;
      html += `<button class="btn act" data-act="stash-apply">Apply stash — keep the entry</button>`;
      html += `<button class="btn act" data-act="stash-pop">Apply stash &amp; drop it</button>`;
      html += `<button class="btn act btn-danger" data-act="stash-drop">Drop stash</button>`;
      html += '</div>';
    }
    html += '<h4>Files changed</h4>';
    html += '<div id="commit-diff" class="diff-files">Loading…</div>';
    html += '<div class="detail-empty"><span class="hint">Click a file to view its diff. Operations run on the checked-out branch; the graph reloads after.</span></div>';
  }
  pane.innerHTML = html;
  if (commit) void loadCommitFiles(commit.hash);

  // wire action buttons
  pane.querySelectorAll<HTMLButtonElement>('button.act').forEach((btn) => {
    btn.addEventListener('click', () => void runAction(btn));
  });

  // wire branch checkout
  pane.querySelectorAll<HTMLLIElement>('li[data-branch]').forEach((li) => {
    li.addEventListener('click', () => void checkout(li.dataset.branch ?? '', li.dataset.remote === 'true'));
  });
}

/** Render the per-file checkbox list inside the commit dialog. */
function renderCommitFiles(entries: StatusEntry[]): void {
  const list = $<HTMLUListElement>('#commit-file-list');
  if (entries.length === 0) {
    list.innerHTML = '<li class="commit-empty muted">Working tree clean — nothing to commit</li>';
  } else {
    list.innerHTML = entries
      .map((e) => {
        const code = e.stagedX === '?' ? '??' : e.stagedX !== ' ' ? e.stagedX : e.unstagedY;
        const oldPath = e.oldPath ?? '';
        return `<li class="commit-file-item">
          <label class="checkbox-label file-row">
            <input type="checkbox" class="commit-file" data-path="${esc(e.path)}" checked />
            <span class="status-badge ${statusClass(e.stagedX === '?' ? '?' : code)}">${esc(code)}</span>
            <span class="status-path" title="${esc(e.path)}">${esc(e.path)}</span>
          </label>
          <button type="button" class="btn btn-sm commit-view-file" data-path="${esc(e.path)}">View</button>
          <button type="button" class="btn btn-sm commit-view-diff" data-path="${esc(e.path)}" data-old-path="${esc(oldPath)}">Diff</button>
        </li>`;
      })
      .join('');
  }
  updateCommitSelection();
}

/** Sync the master checkbox, the count label, and the Commit button with the file list. */
function updateCommitSelection(): void {
  const boxes = [...document.querySelectorAll<HTMLInputElement>('.commit-file')];
  const selected = boxes.filter((b) => b.checked).length;
  const master = $<HTMLInputElement>('#commit-select-all');
  master.checked = boxes.length > 0 && selected === boxes.length;
  master.indeterminate = selected > 0 && selected < boxes.length;
  $('#commit-file-count').textContent =
    boxes.length === 0 ? '' : `${selected} of ${boxes.length} selected`;
  $<HTMLButtonElement>('#commit-submit').disabled = selected === 0;
  const gen = document.querySelector<HTMLButtonElement>('#commit-generate');
  if (gen && !gen.dataset.busy) gen.disabled = selected === 0;
}

/** Load the changed-file list for a commit into the detail pane. */
async function loadCommitFiles(hash: string): Promise<void> {
  const el = document.querySelector('#commit-diff');
  try {
    const { files } = await api<{ files: CommitFile[] }>('/commit-diff', { hash });
    if (!el || selectedHash !== hash) return;
    if (files.length === 0) {
      el.innerHTML = '<span class="muted hint">No changes.</span>';
      return;
    }
    el.innerHTML = files
      .map((file) => {
        const rename =
          file.oldPath && file.oldPath !== file.path
            ? `<span class="file-old" title="${esc(file.oldPath)}">${esc(file.oldPath)} →</span> `
            : '';
        const sub = file.isSubmodule
          ? '<span class="file-submodule" title="Submodule (gitlink)">submodule</span>'
          : '';
        return `<div class="file-entry">
          <button type="button" class="file-row" data-path="${esc(file.path)}" data-old-path="${esc(file.oldPath ?? '')}" data-submodule="${file.isSubmodule ? 'true' : 'false'}">
            <span class="status-badge ${statusClass(file.status)}">${esc(file.status)}</span>
            <span class="file-path" title="${esc(file.path)}">${rename}${esc(file.path)}</span>
            <span class="file-stats">${sub}${fileStatHtml(file)}</span>
          </button>
          <button type="button" class="icon-btn view-file" data-path="${esc(file.path)}" title="View file at this commit" aria-label="View file at this commit">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.6 8s2.4-4.4 6.4-4.4S14.4 8 14.4 8 12 12.4 8 12.4 1.6 8 1.6 8Z" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="1.7" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>
          </button>
        </div>`;
      })
      .join('');
  } catch {
    if (el && selectedHash === hash) el.textContent = '';
  }
}

/** Diff layout preference for the modal viewer. */
type DiffView = 'unified' | 'split';
const DIFF_VIEW_KEY = 'liana-diff-view';

function readDiffView(): DiffView {
  return localStorage.getItem(DIFF_VIEW_KEY) === 'split' ? 'split' : 'unified';
}

/** Cached patch for the currently open file, so toggling layout needn't refetch. */
let diffPatch = '';
let diffView: DiffView = 'unified';
/** Active Monaco diff handle, or null while the HTML fallback is in use. */
let diffHandle: CodeHandle | null = null;

/** Dispose the open Monaco diff editor, if any (called when the dialog closes). */
function disposeDiffEditor(): void {
  diffHandle?.dispose();
  diffHandle = null;
}

/** Mirror `diffView` onto the toggle buttons. */
function syncDiffToggle(): void {
  document.querySelectorAll<HTMLButtonElement>('.diff-view-btn').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.view === diffView);
    b.setAttribute('aria-pressed', String(b.dataset.view === diffView));
  });
}

/** Repaint the open dialog body (Monaco toggles in place; HTML re-renders). */
function renderDiffDialog(): void {
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
async function mountMonacoDiff(original: string, modified: string, path: string): Promise<boolean> {
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
async function openCodeDiff(opts: {
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
function openDiffDialog(path: string, oldPath: string): void {
  const commit = (lastResponse?.commits ?? []).find((c) => c.hash === selectedHash);
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
function openWorktreeDiff(path: string, oldPath: string): void {
  const renamed = oldPath && oldPath !== path ? `${oldPath} → ` : '';
  void openCodeDiff({ path, oldPath, hash: null, subtitle: `${renamed}${path} · working tree` });
}

/** Monaco handle for the read-only whole-file viewer, or null when not mounted. */
let codeViewerHandle: CodeHandle | null = null;

/** Dispose the open whole-file viewer editor, if any. */
function disposeCodeViewer(): void {
  codeViewerHandle?.dispose();
  codeViewerHandle = null;
}

/** Open the read-only whole-file viewer at a commit or in the working tree. */
async function openCodeViewer(path: string, hash: string | null): Promise<void> {
  if (!path) return;
  const dlg = $<HTMLDialogElement>('#code-dialog');
  const body = $<HTMLDivElement>('#code-body');
  $('#code-title').textContent = path;
  $('#code-subtitle').textContent = hash
    ? `commit ${hash.slice(0, 8)} · read-only`
    : 'working tree · read-only';
  $('#code-status').textContent = '';
  disposeCodeViewer();
  body.textContent = 'Loading file…';
  dlg.showModal();
  try {
    const contents = await api<FileContents>('/file-content', { hash, path, oldPath: null });
    if (contents.binary) {
      body.textContent = '';
      body.innerHTML = '<div class="dl-note">Binary file — cannot display.</div>';
      return;
    }
    const code = await loadCode();
    const value = contents.modified ?? contents.original ?? '';
    body.textContent = '';
    if (!code) {
      body.innerHTML = `<pre class="conflict-pre">${esc(value)}</pre>`;
      return;
    }
    codeViewerHandle = code.createEditor(body, value, { path, readOnly: true });
  } catch (err) {
    body.textContent = '';
    $('#code-status').textContent = String(err);
  }
}

/** Open the modal side-by-side conflict viewer for one unresolved path. */
async function openConflictDialog(path: string): Promise<void> {
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
function conflictColumn(label: string, side: 'base' | 'ours' | 'theirs', file: ConflictFile): string {
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
function conflictLinesHtml(lines: TextDiffLine[]): string {
  return lines
    .map((line) => {
      const cls = line.kind === 'add' ? 'dl-add' : line.kind === 'del' ? 'dl-del' : '';
      return `<span class="cl${cls ? ` ${cls}` : ''}">${esc(line.text)}</span>`;
    })
    .join('');
}

// Monaco editors mounted in the conflict dialog. Reference panes are read-only;
// the Result pane is editable and saved back to the working-tree file.
let conflictHandles: CodeHandle[] = [];
let conflictResult: CodeHandle | null = null;

function disposeConflictEditors(): void {
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
async function renderConflictDialog(file: ConflictFile): Promise<void> {
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

// --- AI conflict resolution dialog ---

/** The last model proposal, applied when the user confirms. */
let aiConflictFix: AiConflictFix | null = null;
/** Path the AI dialog is working on, so Regenerate can re-ask. */
let aiConflictPath = '';
/** Guards against a stale proposal landing after the dialog was reopened. */
let aiConflictSeq = 0;

/** Open the AI merge dialog for one conflicted path and request a proposal. */
async function openAiConflictDialog(path: string): Promise<void> {
  if (!path) return;
  aiConflictPath = path;
  $<HTMLButtonElement>('#ai-conflict-apply').disabled = true;
  $<HTMLButtonElement>('#ai-conflict-regenerate').disabled = true;
  $('#ai-conflict-title').textContent = path;
  $('#ai-conflict-subtitle').textContent = '';
  $('#ai-conflict-status').textContent = '';
  $('#ai-conflict-body').innerHTML = '';
  $<HTMLDialogElement>('#ai-conflict-dialog').showModal();
  await requestAiConflictFix(path);
}

/** Ask the backend for a proposed merge and render it. */
async function requestAiConflictFix(path: string): Promise<void> {
  const seq = ++aiConflictSeq;
  aiConflictFix = null;
  const applyBtn = $<HTMLButtonElement>('#ai-conflict-apply');
  const regenBtn = $<HTMLButtonElement>('#ai-conflict-regenerate');
  applyBtn.disabled = true;
  regenBtn.disabled = true;
  $('#ai-conflict-subtitle').textContent = 'Asking the model to merge…';
  $('#ai-conflict-body').innerHTML = '<div class="dl-note">Waiting for the model…</div>';
  $('#ai-conflict-status').textContent = '';
  try {
    const { fix } = await api<{ fix: AiConflictFix }>('/conflict-fix', { path });
    if (seq !== aiConflictSeq) return;
    aiConflictFix = fix;
    renderAiConflictDialog(fix);
    applyBtn.disabled = false;
  } catch (err) {
    if (seq !== aiConflictSeq) return;
    $('#ai-conflict-subtitle').textContent = '';
    $('#ai-conflict-body').innerHTML = '';
    $('#ai-conflict-status').textContent = String(err);
  } finally {
    if (seq === aiConflictSeq) regenBtn.disabled = false;
  }
}

/** Render a proposed merge: explanation plus the merged file (or a delete note). */
function renderAiConflictDialog(fix: AiConflictFix): void {
  const suffix = fix.kind === 'delete' ? ' · resolves by deletion' : '';
  $('#ai-conflict-subtitle').textContent = `Proposed by ${fix.model}${suffix}`;
  const explanation = fix.explanation
    ? `<p class="ai-conflict-explanation">${esc(fix.explanation)}</p>`
    : '';
  const body =
    fix.kind === 'delete'
      ? '<div class="dl-note">The model proposes removing this file.</div>'
      : `<pre class="ai-conflict-pre">${esc(fix.content ?? '')}</pre>`;
  $('#ai-conflict-body').innerHTML = explanation + body;
}

/** Apply the reviewed proposal: the backend writes the file and stages it. */
async function applyAiConflictFix(): Promise<void> {
  const fix = aiConflictFix;
  if (!fix) return;
  const status = $('#ai-conflict-status');
  const applyBtn = $<HTMLButtonElement>('#ai-conflict-apply');
  applyBtn.disabled = true;
  const verb = fix.kind === 'delete' ? 'remove' : 'overwrite';
  if (!confirm(`Apply the AI merge? This will ${verb} ${fix.path} and stage it.`)) {
    applyBtn.disabled = false;
    return;
  }
  try {
    await api('/conflict-apply', { path: fix.path, kind: fix.kind, content: fix.content });
    $<HTMLDialogElement>('#ai-conflict-dialog').close();
    await refresh();
  } catch (err) {
    status.textContent = String(err);
    applyBtn.disabled = false;
  }
}

/** Show a gitlink change as "Subproject commit …" instead of a line diff. */
function openSubprojectDialog(path: string): void {
  const dlg = $<HTMLDialogElement>('#diff-dialog');
  const body = $<HTMLDivElement>('#diff-body');
  disposeDiffEditor();
  $('#diff-title').textContent = path;
  $('#diff-subtitle').textContent = 'Submodule (gitlink) change';
  $('#diff-status').textContent = '';
  diffPatch = '';
  body.classList.remove('is-split', 'is-code');
  body.innerHTML =
    '<div class="dl-note">Subproject commit — the recorded gitlink changed. Liana does not diff submodule contents; open the submodule\'s History to browse it.</div>';
  diffView = readDiffView();
  dlg.showModal();
}

/** One graph node list (rendered as a simple table) for a submodule's history. */
function renderSubmoduleHistory(commits: GitCommit[]): string {
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
async function openSubmoduleHistory(path: string): Promise<void> {
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

/** Lay out the sticky column header to match the SVG's computed column offsets. */
function renderGraphHeader(m: GraphMetrics): void {  const header = $('#graph-header');
  header.style.width = `${m.totalW}px`;
  const labels: Array<[number, string]> = [
    [m.refX, 'Refs'],
    [m.lanesX - 4, 'Graph'],
    [m.subjectX, 'Commit'],
  ];
  header.innerHTML = labels
    .map(([x, label]) => `<span style="left:${Math.max(0, Math.round(x))}px">${label}</span>`)
    .join('');
}

/**
 * Swap between the graph scroller and the empty-repository placeholder. An empty
 * repo has no columns to align, so the sticky header must come down with it rather
 * than pile its labels up at the left edge.
 */
function setGraphEmpty(empty: boolean): void {
  $('#graph-empty').hidden = !empty;
  $('#graph-scroll').hidden = empty;
}

/**
 * Re-paint the graph/detail from the last fetched response without touching the
 * network. Selection and search are pure client state, so a click or keystroke
 * must never re-run the git subprocesses behind `/state`.
 */
function renderCached(): void {
  if (lastResponse) renderAll(lastResponse);
}

function renderAll(resp: StateResponse): void {
  lastResponse = resp;
  const commits = resp.commits ?? [];
  const empty = commits.length === 0;
  // Unhide the scroller before measuring, so renderGraph can size its columns to
  // the live viewport width.
  setGraphEmpty(empty);
  const layout = layoutGraph(commits);
  currentLayout = layout;
  const matches = runSearch(commits);
  // Resolve the focused match before drawing so its band highlights immediately.
  renderSearchResults();
  const highlight: GraphHighlight | null = searchQuery.trim()
    ? { matches: new Set(matches.map((m) => m.commit.hash)), current: searchCurrent }
    : null;
  const svg = $svg('#graph-svg');
  if (empty) {
    svg.replaceChildren();
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
  }
  const metrics = empty
    ? EMPTY_METRICS
    : renderGraph(svg, { name: repoName, ...resp.state } as RepoState, layout, selectedHash, highlight);
  renderGraphHeader(metrics);
  renderDetail(commits, resp.state, resp.status);
  updateSyncButtons();
  renderStatusBar();
}

// --- Search: commits, branches, and tags ---

/** A commit that matched the active query, with the fields that matched. */
interface SearchMatch {
  commit: GitCommit;
  /** Human labels for what matched: "subject", "author", "branch main", "tag v1.0", … */
  fields: string[];
}

/** Human label for a ref: distinguishes branches from tags and stashes. */
function refSearchLabel(ref: GitRef): string {
  switch (ref.kind) {
    case 'local':
      return `branch ${ref.name}`;
    case 'remote':
      return `remote branch ${ref.name}`;
    case 'tag':
      return `tag ${ref.name}`;
    case 'stash':
      return `stash ${ref.name}`;
    default:
      return ref.name;
  }
}

/** True when a ref name (branch/tag/stash) matches every query token. */
function refMatches(ref: GitRef, tokens: string[]): boolean {
  const name = ref.name.toLowerCase();
  return tokens.every((t) => name.includes(t));
}

/**
 * Filter `commits` by the active query. Every whitespace-separated token must
 * match somewhere (AND); matching is case-insensitive across subject, author,
 * hash, and ref names — local branches, remote branches, tags, and stashes.
 */
function runSearch(commits: GitCommit[]): SearchMatch[] {
  const q = searchQuery.trim().toLowerCase();
  if (!q) {
    searchMatches = [];
    searchCurrent = null;
    return searchMatches;
  }
  const tokens = q.split(/\s+/).filter(Boolean);
  const matches: SearchMatch[] = [];
  for (const commit of commits) {
    const fields: string[] = [];
    if (tokens.every((t) => commit.subject.toLowerCase().includes(t))) fields.push('subject');
    if (tokens.every((t) => commit.author.toLowerCase().includes(t))) fields.push('author');
    if (tokens.every((t) => commit.hash.toLowerCase().includes(t))) fields.push('hash');
    for (const ref of commit.refs) {
      if (!refMatches(ref, tokens)) continue;
      fields.push(refSearchLabel(ref));
    }
    if (commit.stash) {
      const haystack = `${commit.stash.message} ${commit.stash.branch ?? ''}`.toLowerCase();
      if (tokens.every((t) => haystack.includes(t))) fields.push('stash');
    }
    if (fields.length > 0) matches.push({ commit, fields: [...new Set(fields)] });
  }
  searchMatches = matches;
  return matches;
}

/** Scroll the graph so the row for `hash` is centered in the viewport. */
function scrollToHash(hash: string): void {
  const scroller = document.querySelector('#graph-scroll');
  if (!(scroller instanceof HTMLElement)) return;
  const hit = document.querySelector(`#graph-svg rect.graph-row-hit[data-hash="${hash}"]`);
  if (!(hit instanceof SVGRectElement)) return;
  const scrollerRect = scroller.getBoundingClientRect();
  const hitRect = hit.getBoundingClientRect();
  if (hitRect.top >= scrollerRect.top && hitRect.bottom <= scrollerRect.bottom) return;
  const delta = hitRect.top - scrollerRect.top - (scrollerRect.height - hitRect.height) / 2;
  scroller.scrollBy({ top: delta, behavior: 'smooth' });
}

/** Select a search result, reload the view, and bring its row into sight. */
function focusMatch(hash: string): void {
  searchCurrent = hash;
  selectedHash = hash;
  renderCached();
  scrollToHash(hash);
}

/** Move the focused match by `delta` (wrapping), then focus it. */
function searchStep(delta: number): void {
  if (searchMatches.length === 0) return;
  const idx = searchMatches.findIndex((m) => m.commit.hash === searchCurrent);
  const next =
    idx === -1
      ? delta > 0
        ? 0
        : searchMatches.length - 1
      : (idx + delta + searchMatches.length) % searchMatches.length;
  const match = searchMatches[next];
  if (match) focusMatch(match.commit.hash);
}

/** Render the results list and the "n/total" counter for the current query. */
function renderSearchResults(): void {
  const list = $('#search-results');
  const count = $('#search-count');
  if (!searchQuery.trim()) {
    list.replaceChildren();
    count.textContent = '';
    return;
  }
  if (searchMatches.length === 0) {
    list.innerHTML = '<li class="search-empty muted">No commits or tags match.</li>';
    count.textContent = '0/0';
    return;
  }
  if (!searchCurrent || !searchMatches.some((m) => m.commit.hash === searchCurrent)) {
    searchCurrent = searchMatches[0]?.commit.hash ?? null;
  }
  const idx = searchMatches.findIndex((m) => m.commit.hash === searchCurrent);
  count.textContent = `${idx + 1}/${searchMatches.length}`;
  list.replaceChildren(
    ...searchMatches.map((m, i) => {
      const li = document.createElement('li');
      li.className = `search-result${i === idx ? ' is-current' : ''}`;
      li.dataset.hash = m.commit.hash;
      li.innerHTML = `
        <div class="search-result-main">
          <span class="search-result-subject" title="${esc(m.commit.subject)}">${esc(m.commit.subject)}</span>
          <code class="search-result-hash">${m.commit.hash.slice(0, 8)}</code>
        </div>
        <div class="search-result-meta muted">
          <span class="search-result-author">${esc(m.commit.author)}</span>
          <span>${isoDate(m.commit.timestamp)}</span>
          <span class="search-result-refs" title="Matched: ${esc(m.fields.join(', '))}">${esc(m.fields.join(' · '))}</span>
        </div>`;
      li.addEventListener('click', () => focusMatch(m.commit.hash));
      return li;
    }),
  );
}

function openSearch(): void {
  const panel = $('#search-panel');
  panel.hidden = false;
  $('#btn-search').setAttribute('aria-expanded', 'true');
  // Anchor under the search button, clamped to the viewport.
  const rect = $('#btn-search').getBoundingClientRect();
  const width = panel.getBoundingClientRect().width;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  panel.style.left = `${left}px`;
  panel.style.right = 'auto';
  const input = $<HTMLInputElement>('#search-input');
  input.focus();
  input.select();
}

function closeSearch(): void {
  const panel = $('#search-panel');
  if (panel.hidden) return;
  panel.hidden = true;
  $('#btn-search').setAttribute('aria-expanded', 'false');
  searchQuery = '';
  searchCurrent = null;
  searchMatches = [];
  $<HTMLInputElement>('#search-input').value = '';
  window.clearTimeout(searchDebounce);
  renderCached();
}

/** True when the event target is a text field, so shortcuts don't hijack typing. */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

$('#btn-search').addEventListener('click', () => {
  if ($('#search-panel').hidden) openSearch();
  else closeSearch();
});

$('#search-close').addEventListener('click', () => closeSearch());
$('#search-next').addEventListener('click', () => searchStep(1));
$('#search-prev').addEventListener('click', () => searchStep(-1));

// Search only filters the already-fetched log, so debounce the rebuild and
// never hit `/state` while the user is typing.
let searchDebounce: number | undefined;
$('#search-input').addEventListener('input', (ev) => {
  searchQuery = (ev.target as HTMLInputElement).value;
  searchCurrent = null;
  window.clearTimeout(searchDebounce);
  searchDebounce = window.setTimeout(renderCached, 150);
});

$('#search-input').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') {
    ev.preventDefault();
    searchStep(ev.shiftKey ? -1 : 1);
  } else if (ev.key === 'Escape') {
    ev.preventDefault();
    ev.stopPropagation();
    closeSearch();
  }
});

document.addEventListener('pointerdown', (ev) => {
  const panel = $('#search-panel');
  const btn = $('#btn-search');
  if (!panel.hidden && !panel.contains(ev.target as Node) && !btn.contains(ev.target as Node)) {
    closeSearch();
  }
});

document.addEventListener('keydown', (ev) => {
  const isFind = (ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'f';
  if (ev.key !== '/' && !isFind) return;
  const input = $<HTMLInputElement>('#search-input');
  if (isFind && document.activeElement === input && !$('#search-panel').hidden) {
    ev.preventDefault();
    input.select();
    return;
  }
  if (isTypingTarget(ev.target)) return;
  if (document.querySelector('dialog[open]')) return;
  ev.preventDefault();
  openSearch();
});

// --- Repository tabs ---

interface RepoEntry {
  id: string;
  path: string;
  name: string;
}

const REPOS_KEY = 'liana-repos';
const ACTIVE_KEY = 'liana-active-repo';

/** Persist the open tab paths and the active tab, in order. */
function persistTabs(): void {
  try {
    localStorage.setItem(REPOS_KEY, JSON.stringify(tabs.map((t) => t.path)));
    const active = activeTab();
    if (active) localStorage.setItem(ACTIVE_KEY, active.path);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {
    // localStorage may be unavailable (private mode); tabs still work in-session.
  }
}

function readSavedRepos(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(REPOS_KEY) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

/** Render the tab strip from `tabs`/`activeId`. */
function renderTabs(): void {
  const strip = $('#repo-tabs');
  strip.hidden = tabs.length === 0;
  strip.replaceChildren();
  if (tabs.length === 0) return;
  for (const tab of tabs) {
    const dirty = tab.lastResponse?.status?.entries.length ?? 0;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `repo-tab${tab.id === activeId ? ' is-active' : ''}`;
    btn.title = tab.path;
    btn.dataset.repo = tab.id;

    const name = document.createElement('span');
    name.className = 'repo-tab-name';
    name.textContent = tab.name;
    btn.appendChild(name);

    if (dirty > 0) {
      const dot = document.createElement('span');
      dot.className = 'dirty-dot';
      dot.title = `${dirty} uncommitted ${dirty === 1 ? 'change' : 'changes'}`;
      btn.appendChild(dot);
    }

    const close = document.createElement('span');
    close.className = 'repo-tab-close';
    close.textContent = '\u00d7';
    close.title = `Close ${tab.name}`;
    close.setAttribute('role', 'button');
    close.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeTab(tab.id);
    });
    btn.appendChild(close);

    btn.addEventListener('click', () => void activateRepo(tab.id));
    strip.appendChild(btn);

    // A review tab, once opened for this repository, sits right after its repo tab.
    if (reviewTabs.has(tab.id)) {
      const review = document.createElement('button');
      review.type = 'button';
      review.className = `repo-tab repo-tab-review${tab.id === activeReviewId ? ' is-active' : ''}`;
      review.title = `Code review — ${tab.name}`;
      review.dataset.review = tab.id;
      review.innerHTML =
        `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2.4h10v11.2H3z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M5.4 5.4h5.2M5.4 8h5.2M5.4 10.6h3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
      const name = document.createElement('span');
      name.className = 'repo-tab-name';
      name.textContent = `Code review · ${tab.name}`;
      review.appendChild(name);
      const close = document.createElement('span');
      close.className = 'repo-tab-close';
      close.textContent = '\u00d7';
      close.title = `Close ${tab.name} code review`;
      close.setAttribute('role', 'button');
      close.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeReviewTab(tab.id);
      });
      review.appendChild(close);
      review.addEventListener('click', () => activateReviewTab(tab.id));
      strip.appendChild(review);
    }
  }

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'repo-tab-new';
  add.textContent = '+';
  add.title = 'Open another repository';
  add.setAttribute('aria-label', 'Open another repository');
  add.addEventListener('click', () => void openRepo());
  strip.appendChild(add);
}

// --- Actions ---

/** Render the empty state shown when no repository is open. */
function renderNoRepo(): void {
  // No repo means no columns: hide the scroller (and its stale header) entirely.
  $('#graph-scroll').hidden = true;
  $('#graph-empty').hidden = true;
  renderGraphHeader(EMPTY_METRICS);
  const svg = $svg('#graph-svg');
  svg.replaceChildren();
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  const pane = $('#detail-pane');
  pane.innerHTML =
    `<div class="detail-empty">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm11 13.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0ZM4.5 5v6.75c0 .4.1.6.35.85l3.3 3.3c.5.5 1.35.5 1.85 0l.6-.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
      <strong>liana</strong>
      <span class="hint">Open a local git repository to see its commit graph.</span>
      <button class="btn btn-primary" id="empty-open-repo">Open repository…</button>
    </div>`;
  pane.querySelector('#empty-open-repo')?.addEventListener('click', () => void openRepo());
  updateSyncButtons();
  renderStatusBar();
}

/** Open a folder picker and add the chosen repository as a tab. */
async function openRepo(): Promise<void> {
  // Electron has no window.prompt — use the native folder picker when available.
  const p = window.liana
    ? await window.liana.openRepoDialog()
    : prompt('Path to git repository:', '~/workspace/my-repo');
  if (!p) return;
  try {
    await addRepo(p, true);
  } catch (err) {
    alert(String(err));
  }
}

/** Register `path` with the server and add (or focus) its tab. */
async function addRepo(path: string, activate: boolean): Promise<void> {
  const res = await api<RepoEntry>('/open', { path }, { scoped: false });
  const existing = tabs.find((t) => t.path === res.path);
  if (existing) {
    const wasActive = existing.id === activeId;
    existing.id = res.id;
    if (wasActive) {
      // The server re-issued this tab's id (e.g. dev-server restart): rebind it.
      activeId = res.id;
      await refresh();
    } else if (activate) {
      await activateRepo(res.id);
    } else {
      renderTabs();
      persistTabs();
    }
    return;
  }
  const tab: RepoTab = {
    id: res.id,
    path: res.path,
    name: res.name,
    selectedHash: null,
    lastResponse: null,
    remoteStatus: null,
    panX: 0,
    panY: 0,
    zoom: 1,
  };
  tabs.push(tab);
  if (activate) await activateRepo(tab.id);
  else {
    renderTabs();
    persistTabs();
  }
}

/** Switch the active tab: paint the cached view, then refresh so its dirty dot stays accurate. */
async function activateRepo(id: string): Promise<void> {
  // Selecting a repository always returns to the graph view. Any open review
  // tabs keep their state; the one bound to this repo is just hidden.
  if (activeReviewId !== null) {
    activeReviewId = null;
    updateReviewVisibility();
    renderTabs();
    persistReviewTabs();
  }
  if (id === activeId) {
    if (lastResponse) renderAll(lastResponse);
    return;
  }
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return;
  saveActive();
  loadTab(tab);
  if (tab.lastResponse) renderAll(tab.lastResponse);
  await refresh();
}

/** Show the review tab for `repoId`, preserving its loaded MR/job state. */
function activateReviewTab(repoId: string): void {
  const state = reviewTabs.get(repoId);
  if (!state) return;
  // The review is bound to one repository; rebind it as active so subsequent
  // review/GitLab API calls target the same repo the MR belongs to.
  const bound = tabs.find((t) => t.id === repoId);
  if (!bound) {
    closeReviewTab(repoId);
    return;
  }
  if (activeId !== repoId) {
    saveActive();
    loadTab(bound);
    if (bound.lastResponse) renderAll(bound.lastResponse);
    void refresh();
  }
  activeReviewId = repoId;
  updateReviewVisibility();
  paintReview(state);
  renderTabs();
  persistReviewTabs();
  if (!state.job) void loadSessionsAndMaybeRestore(state);
}

/** Close a tab; adjacent tab becomes active when the closed one was active. */
function closeTab(id: string): void {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const wasActive = id === activeId;
  tabs.splice(idx, 1);
  // Closing a repository closes its review tab too.
  if (reviewTabs.has(id)) {
    closeReviewTab(id);
  }
  if (wasActive) {
    const next = tabs[idx] ?? tabs[idx - 1] ?? tabs[tabs.length - 1];
    if (next) {
      loadTab(next);
      void refresh();
    } else {
      activeId = null;
      selectedHash = null;
      lastResponse = null;
      remoteStatus = null;
      repoName = '';
      renderNoRepo();
    }
  }
  updateReviewVisibility();
  renderTabs();
  persistTabs();
  persistReviewTabs();
}

async function refresh(): Promise<void> {
  const reqId = activeId;
  const tab = activeTab();
  if (!tab) {
    renderNoRepo();
    return;
  }
  try {
    const [resp, remote] = await Promise.all([
      api<StateResponse>('/state'),
      api<RemoteStatus>('/remote-status').catch(() => null),
    ]);
    // A tab switch landed while this was in flight — drop the stale response.
    if (activeId !== reqId) return;
    repoName = resp.state?.name ?? tab.name;
    tab.name = repoName;
    if (activeReviewId === tab.id) updateReviewVisibility();
    tab.lastResponse = resp;
    tab.remoteStatus = remote;
    lastResponse = resp;
    remoteStatus = remote;
    // While a review tab is shown the graph columns are hidden, so skip
    // drawing; closing the review tab re-renders from the cached response.
    if (activeReviewId === null) renderAll(resp);
    renderTabs();
    persistTabs();
    void refreshActivity();
  } catch (err) {
    if (activeId !== reqId) return;
    $('#detail-pane').innerHTML = `<p class="error">Failed to load repo: ${esc(String(err))}</p>`;
  }
}

async function runAction(btn: HTMLButtonElement): Promise<void> {
  const act = btn.dataset.act ?? '';
  const path = btn.dataset.path ?? '';
  btn.disabled = true;
  try {
    if (act === 'stash-apply') {
      await api('/stash-apply', { hash: selectedHash });
    } else if (act === 'stash-pop') {
      await api('/stash-apply', { hash: selectedHash });
      await api('/stash-drop', { hash: selectedHash });
      selectedHash = null;
    } else if (act === 'stash-drop') {
      if (!confirm('Drop this stash entry? The saved changes are discarded.')) return;
      await api('/stash-drop', { hash: selectedHash });
      selectedHash = null;
    } else if (act === 'view-conflict') {
      await openConflictDialog(path);
      return;
    } else if (act === 'ai-fix-conflict') {
      await openAiConflictDialog(path);
      return;
    } else if (act === 'take-ours') {
      if (!confirm(`Resolve ${path} using our version?`)) return;
      await api('/conflict-resolve', { path, resolution: 'ours' });
    } else if (act === 'take-theirs') {
      if (!confirm(`Resolve ${path} using their version?`)) return;
      await api('/conflict-resolve', { path, resolution: 'theirs' });
    } else if (act === 'mark-resolved') {
      await api('/conflict-resolve', { path, resolution: 'resolved' });
    } else if (act === 'op-continue') {
      await api('/conflict-continue', {});
    } else if (act === 'op-skip') {
      if (!confirm('Skip this patch? Its changes are discarded.')) return;
      await api('/conflict-skip', {});
    } else if (act === 'op-abort') {
      if (!confirm('Abort the in-progress operation? The working tree is restored first.')) return;
      await api('/conflict-abort', {});
    } else if (act === 'sub-log') {
      await openSubmoduleHistory(path);
      if (btn.isConnected) btn.disabled = false;
      return;
    } else if (act === 'sub-update') {
      await api('/submodule-update', { init: true });
    } else if (act === 'sub-sync') {
      await api('/submodule-sync', {});
    } else if (act === 'sub-deinit') {
      if (!confirm(`Deinitialize ${path}? Its working tree is removed (the recorded commit is kept).`)) return;
      await api('/submodule-deinit', { path, force: true });
    } else if (act === 'copy-subject' || act === 'copy-hash') {
      await copyToClipboard(btn.dataset.copy ?? '');
      return;
    }
    await refresh();
  } catch (err) {
    alert(`Operation failed:\n${String(err)}`);
  } finally {
    if (btn.isConnected) btn.disabled = false;
  }
}

// --- Interactive rebase dialog ---

interface RebaseStartResponse {
  ok: boolean;
  onto: string;
  items: Array<{ hash: string; subject: string; author: string; timestamp: number }>;
}

function renderRebaseTodo(
  items: Array<{ hash: string; subject: string }>,
): void {
  const ol = $<HTMLOListElement>('#rebase-todo');
  ol.innerHTML = items
    .map(
      (c) =>
        `<li data-hash="${esc(c.hash)}" data-action="pick">
          <select class="rebase-action">
            <option value="pick">pick</option>
            <option value="reword">reword</option>
            <option value="squash">squash</option>
            <option value="drop">drop</option>
          </select>
          <code>${esc(c.hash.slice(0, 8))}</code>
          <span class="rebase-subject">${esc(c.subject)}</span>
          <input class="rebase-message" type="text" placeholder="new message" />
        </li>`,
    )
    .join('');

  ol.querySelectorAll<HTMLLIElement>('li').forEach((li) => {
    const select = li.querySelector<HTMLSelectElement>('.rebase-action');
    const msg = li.querySelector<HTMLInputElement>('.rebase-message');
    if (!select || !msg) return;
    const sync = () => {
      const needsMsg = select.value === 'reword' || select.value === 'squash';
      msg.classList.toggle('visible', needsMsg);
      li.dataset.action = select.value;
    };
    select.addEventListener('change', sync);
    sync();
  });
}

/** Commit hash the open interactive-rebase dialog is based on. */
let rebaseOnto: string | null = null;

async function openRebaseDialog(onto: string): Promise<void> {
  if (!onto) return;
  const dlg = $<HTMLDialogElement>('#rebase-dialog');
  $('#rebase-status').textContent = '';
  try {
    const plan = await api<RebaseStartResponse>('/rebase-start', { onto });
    if (plan.items.length === 0) {
      alert('Nothing to rebase: HEAD is already based on this commit.');
      return;
    }
    $('#rebase-summary').textContent = `${plan.items.length} commit(s) to replay onto ${plan.onto.slice(0, 8)} — oldest first`;
    rebaseOnto = onto;
    renderRebaseTodo(plan.items);
    dlg.showModal();
  } catch (err) {
    alert(`Cannot start rebase:\n${String(err)}`);
  }
}

async function submitRebase(): Promise<void> {
  const dlg = $<HTMLDialogElement>('#rebase-dialog');
  const onto = rebaseOnto;
  if (!onto) return;
  const items: RebaseTodoItem[] = [];
  $('#rebase-todo')
    .querySelectorAll<HTMLLIElement>('li')
    .forEach((li) => {
      const hash = li.dataset.hash ?? '';
      const action = (li.querySelector<HTMLSelectElement>('.rebase-action')?.value ?? 'pick') as RebaseAction;
      const message = li.querySelector<HTMLInputElement>('.rebase-message')?.value.trim() || undefined;
      items.push({ hash, subject: '', author: '', timestamp: 0, action, message });
    });
  const status = $('#rebase-status');
  try {
    await api('/rebase-execute', { onto, items });
    rebaseOnto = null;
    dlg.close();
    await refresh();
  } catch (err) {
    status.textContent = String(err);
  }
}

async function checkout(branch: string, remote = false): Promise<void> {
  if (!branch) return;
  await api('/checkout', remote ? { branch, remote: true } : { branch });
  selectedHash = null;
  await refresh();
}

/** Local branch name a remote-tracking ref (`origin/feature`) checks out as. */
function remoteLocalName(name: string): string | null {
  const m = /^[^/]+\/(.+)$/.exec(name);
  const branch = m?.[1] ?? '';
  return branch && branch !== 'HEAD' ? branch : null;
}

// --- Theme ---

const THEME_KEY = 'liana-theme';

interface ThemeDef {
  id: string;
  label: string;
  /** [accent, secondary] used for the swatch in the picker. */
  swatch: [string, string];
  dark: boolean;
}

const THEMES: ThemeDef[] = [
  { id: 'midnight', label: 'Midnight', swatch: ['#a78bfa', '#22d3ee'], dark: true },
  { id: 'dracula', label: 'Dracula', swatch: ['#bd93f9', '#8be9fd'], dark: true },
  { id: 'nord', label: 'Nord', swatch: ['#88c0d0', '#81a1c1'], dark: true },
  { id: 'gruvbox', label: 'Gruvbox', swatch: ['#d79921', '#b8bb26'], dark: true },
  { id: 'solarized', label: 'Solarized', swatch: ['#268bd2', '#2aa198'], dark: true },
  { id: 'phosphor', label: 'Phosphor', swatch: ['#35ff6d', '#7dffb0'], dark: true },
  { id: 'tokyo-night', label: 'Tokyo Night', swatch: ['#7aa2f7', '#bb9af7'], dark: true },
  { id: 'catppuccin', label: 'Catppuccin Mocha', swatch: ['#cba6f7', '#89dceb'], dark: true },
  { id: 'one-dark', label: 'One Dark', swatch: ['#61afef', '#c678dd'], dark: true },
  { id: 'monokai', label: 'Monokai', swatch: ['#f92672', '#a6e22e'], dark: true },
  { id: 'rose-pine', label: 'Rosé Pine', swatch: ['#c4a7e7', '#ebbcba'], dark: true },
  { id: 'everforest', label: 'Everforest', swatch: ['#a7c080', '#dbbc7f'], dark: true },
  { id: 'synthwave', label: "Synthwave '84", swatch: ['#ff7edb', '#36f9f6'], dark: true },
  { id: 'ayu-dark', label: 'Ayu Dark', swatch: ['#ffb454', '#39bae6'], dark: true },
  { id: 'light', label: 'Light', swatch: ['#7c3aed', '#0891b2'], dark: false },
];

const DEFAULT_THEME = 'midnight';

function isThemeId(id: string | undefined | null): id is string {
  return !!id && THEMES.some((t) => t.id === id);
}

function currentTheme(): string {
  const id = document.documentElement.dataset.theme;
  return isThemeId(id) ? id : DEFAULT_THEME;
}

function applyTheme(theme: string): void {
  const id = isThemeId(theme) ? theme : DEFAULT_THEME;
  document.documentElement.dataset.theme = id;
  document.querySelectorAll<HTMLButtonElement>('.theme-option').forEach((btn) => {
    btn.setAttribute('aria-checked', String(btn.dataset.themeValue === id));
  });
  // Keep any mounted Monaco editors in step with the theme.
  if (codeModule) codeModule.applyTheme();
}

function selectTheme(theme: string): void {
  if (!isThemeId(theme)) return;
  applyTheme(theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // localStorage may be unavailable (private mode); theme still applies in-session.
  }
}

function initTheme(): void {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(THEME_KEY);
  } catch {
    // ignore
  }
  applyTheme(isThemeId(stored) ? stored : DEFAULT_THEME);
}

/** Build the theme grid inside the settings dialog. */
function buildThemeOptions(): void {
  const wrap = $('#theme-options');
  wrap.replaceChildren();
  for (const theme of THEMES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-option';
    btn.dataset.themeValue = theme.id;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', 'false');

    const swatch = document.createElement('span');
    swatch.className = 'theme-swatch';
    swatch.style.background = `linear-gradient(135deg, ${theme.swatch[0]} 0%, ${theme.swatch[1]} 100%)`;

    const label = document.createElement('span');
    label.textContent = theme.label;

    const check = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    check.setAttribute('viewBox', '0 0 16 16');
    check.setAttribute('aria-hidden', 'true');
    check.classList.add('theme-check');
    const tick = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    tick.setAttribute('d', 'M3.2 8.4 6.4 11.6 12.8 4.8');
    tick.setAttribute('fill', 'none');
    tick.setAttribute('stroke', 'currentColor');
    tick.setAttribute('stroke-width', '1.8');
    tick.setAttribute('stroke-linecap', 'round');
    tick.setAttribute('stroke-linejoin', 'round');
    check.appendChild(tick);

    btn.append(swatch, label, check);
    btn.addEventListener('click', () => selectTheme(theme.id));
    wrap.appendChild(btn);
  }
  applyTheme(currentTheme());
}

$('#btn-about').addEventListener('click', () => {
  $('#about-version').textContent = __APP_VERSION__;
  closeMoreMenu();
  $<HTMLDialogElement>('#about-dialog').showModal();
});

$('#about-close').addEventListener('click', (ev) => {
  ev.preventDefault();
  $<HTMLDialogElement>('#about-dialog').close();
});

$('#diff-close').addEventListener('click', (ev) => {
  ev.preventDefault();
  disposeDiffEditor();
  $<HTMLDialogElement>('#diff-dialog').close();
});

$('#code-close').addEventListener('click', (ev) => {
  ev.preventDefault();
  disposeCodeViewer();
  $<HTMLDialogElement>('#code-dialog').close();
});

// Dispose Monaco editors on any close path (button or Escape's native cancel).
$<HTMLDialogElement>('#diff-dialog').addEventListener('close', () => disposeDiffEditor());
$<HTMLDialogElement>('#code-dialog').addEventListener('close', () => disposeCodeViewer());
$<HTMLDialogElement>('#conflict-dialog').addEventListener('close', () => disposeConflictEditors());

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

// --- Conflict resolution dialog ---

/** Path the open conflict dialog refers to, so its buttons can resolve it. */
let conflictPath = '';

$('#conflict-close').addEventListener('click', (ev) => {
  ev.preventDefault();
  disposeConflictEditors();
  $<HTMLDialogElement>('#conflict-dialog').close();
});

async function resolveFromDialog(resolution: 'ours' | 'theirs'): Promise<void> {
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
async function saveConflictFromDialog(): Promise<void> {
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

$('#conflict-ours').addEventListener('click', () => void resolveFromDialog('ours'));
$('#conflict-theirs').addEventListener('click', () => void resolveFromDialog('theirs'));
$('#conflict-save').addEventListener('click', () => void saveConflictFromDialog());
$('#conflict-ai-fix').addEventListener('click', () => {
  $<HTMLDialogElement>('#conflict-dialog').close();
  void openAiConflictDialog(conflictPath);
});

$('#ai-conflict-close').addEventListener('click', (ev) => {
  ev.preventDefault();
  aiConflictSeq++;
  $<HTMLDialogElement>('#ai-conflict-dialog').close();
});
$('#ai-conflict-regenerate').addEventListener('click', () => void requestAiConflictFix(aiConflictPath));
$('#ai-conflict-apply').addEventListener('click', () => void applyAiConflictFix());

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

// --- Toolbar "three dots" menu ---

const moreMenu = $('#more-menu');
const moreButton = $('#btn-more');

function closeMoreMenu(): void {
  moreMenu.hidden = true;
  moreButton.setAttribute('aria-expanded', 'false');
}

$('#btn-more').addEventListener('click', () => {
  if (!moreMenu.hidden) {
    closeMoreMenu();
    return;
  }
  moreMenu.hidden = false;
  moreButton.setAttribute('aria-expanded', 'true');
  const rect = moreButton.getBoundingClientRect();
  moreMenu.style.top = `${rect.bottom + 6}px`;
  moreMenu.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
  moreMenu.style.left = 'auto';
});

document.addEventListener('pointerdown', (ev) => {
  if (!moreMenu.hidden && !moreMenu.contains(ev.target as Node) && !moreButton.contains(ev.target as Node)) {
    closeMoreMenu();
  }
  if (
    !statusHistory.hidden &&
    !statusHistory.contains(ev.target as Node) &&
    !$('#status-command').contains(ev.target as Node)
  ) {
    closeStatusHistory();
  }
});
window.addEventListener('resize', () => {
  closeMoreMenu();
  closeStatusHistory();
});

// --- Wire up static UI ---

// The header X closes a dialog by activating the same footer button, so
// per-dialog cleanup (Monaco disposal, promise resolution) still runs.
document.querySelectorAll<HTMLButtonElement>('.dialog-close').forEach((btn) => {
  btn.addEventListener('click', (ev) => {
    ev.preventDefault();
    const dlg = btn.closest('dialog');
    dlg?.querySelector<HTMLButtonElement>('menu button[id$="-close"], menu button[id$="-cancel"]')?.click();
  });
});

$('#btn-refresh').addEventListener('click', () => void refresh());

$('#btn-stash').addEventListener('click', () => {
  const dlg = $<HTMLDialogElement>('#stash-dialog');
  $('#stash-status').textContent = '';
  $<HTMLInputElement>('#stash-message').value = '';
  $<HTMLInputElement>('#stash-untracked').checked = false;
  dlg.showModal();
});

// Submit (not click) so Enter in the message field runs the stash instead of
// implicitly activating Cancel, the first submit button.
$('#stash-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const message = $<HTMLInputElement>('#stash-message').value.trim();
  const includeUntracked = $<HTMLInputElement>('#stash-untracked').checked;
  void (async () => {
    try {
      const res = await api<{ stashed: boolean }>('/stash', { message, includeUntracked });
      $<HTMLDialogElement>('#stash-dialog').close();
      if (!res.stashed) {
        alert('No local changes to stash.');
        return;
      }
      await refresh();
    } catch (err) {
      $('#stash-status').textContent = String(err);
    }
  })();
});

$('#stash-cancel').addEventListener('click', () => {
  $<HTMLDialogElement>('#stash-dialog').close();
});

$('#btn-commit').addEventListener('click', () => {
  void (async () => {
    const dlg = $<HTMLDialogElement>('#commit-dialog');
    $('#commit-status').textContent = '';
    try {
      const resp = await api<StateResponse>('/state');
      renderCommitFiles(resp.status?.entries ?? []);
    } catch {
      renderCommitFiles([]);
    }
    dlg.showModal();
  })();
});

$('#commit-select-all').addEventListener('change', (ev) => {
  const checked = (ev.target as HTMLInputElement).checked;
  document.querySelectorAll<HTMLInputElement>('.commit-file').forEach((b) => (b.checked = checked));
  updateCommitSelection();
});

$('#commit-file-list').addEventListener('change', () => updateCommitSelection());

/** Draft a commit message for the checked files with the active AI provider. */
async function generateCommitMessage(): Promise<void> {
  const status = $('#commit-status');
  const textarea = $<HTMLTextAreaElement>('#commit-message');
  const btn = $<HTMLButtonElement>('#commit-generate');
  const files = [...document.querySelectorAll<HTMLInputElement>('.commit-file:checked')].map(
    (b) => b.dataset.path ?? '',
  );
  if (files.length === 0) {
    status.textContent = 'Select at least one file';
    return;
  }
  btn.dataset.busy = '1';
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Generating…';
  status.textContent = '';
  try {
    const { message } = await api<{ message: string }>('/commit-message', { files });
    if (message) textarea.value = message;
    else status.textContent = 'The model returned an empty message';
  } catch (err) {
    status.textContent = String(err);
  } finally {
    delete btn.dataset.busy;
    btn.textContent = original;
    updateCommitSelection();
  }
}

$('#commit-generate').addEventListener('click', () => void generateCommitMessage());

// The Diff button is a sibling of the row's <label>, so clicking it doesn't hit
// the checkbox; delegate here to open the working-tree diff.
$('#commit-file-list').addEventListener('click', (ev) => {
  const target = ev.target;
  if (!(target instanceof Element)) return;
  const btn = target.closest<HTMLButtonElement>('.commit-view-diff');
  if (btn) {
    openWorktreeDiff(btn.dataset.path ?? '', btn.dataset.oldPath ?? '');
    return;
  }
  const view = target.closest<HTMLButtonElement>('.commit-view-file');
  if (view) void openCodeViewer(view.dataset.path ?? '', null);
});

// Submit (not click) so Enter on a focused control runs the commit instead of
// implicitly activating Cancel, the first submit button.
$('#commit-form').addEventListener('submit', (ev) => {
  // Keep the dialog open until the commit succeeds so errors stay visible.
  ev.preventDefault();
  const msg = $<HTMLTextAreaElement>('#commit-message').value.trim();
  if (!msg) {
    $('#commit-status').textContent = 'Message required';
    return;
  }
  const files = [...document.querySelectorAll<HTMLInputElement>('.commit-file:checked')].map(
    (b) => b.dataset.path ?? '',
  );
  if (files.length === 0) {
    $('#commit-status').textContent = 'Select at least one file';
    return;
  }
  void (async () => {
    try {
      await api('/commit', { message: msg, files });
      $<HTMLTextAreaElement>('#commit-message').value = '';
      $<HTMLDialogElement>('#commit-dialog').close();
      await refresh();
    } catch (err) {
      $('#commit-status').textContent = String(err);
    }
  })();
});

$('#commit-cancel').addEventListener('click', () => {
  $<HTMLDialogElement>('#commit-dialog').close();
});

$('#rebase-submit').addEventListener('click', (ev) => {
  ev.preventDefault();
  void submitRebase();
});

$('#rebase-cancel').addEventListener('click', (ev) => {
  ev.preventDefault();
  rebaseOnto = null;
  $<HTMLDialogElement>('#rebase-dialog').close();
});

// --- Push / pull / remotes ---

/** Enable the sync buttons and set an informative tooltip from the remote status. */
function updateSyncButtons(): void {
  const hasRepo = !!activeTab();
  const rs = remoteStatus;
  const push = $<HTMLButtonElement>('#btn-push');
  const pull = $<HTMLButtonElement>('#btn-pull');
  push.disabled = !hasRepo;
  pull.disabled = !hasRepo;
  if (!hasRepo) return;
  if (!rs || rs.remotes.length === 0) {
    push.title = 'No remote configured';
    pull.title = 'No remote configured';
    return;
  }
  const branch = rs.currentBranch ?? 'detached HEAD';
  push.title = rs.upstream
    ? `Push ${branch} to ${rs.upstream} (shift-click to force-push with lease)`
    : `Push ${branch} and set upstream`;
  pull.title = rs.upstream ? `Pull ${rs.upstream} into ${branch}` : 'Push first to set an upstream';
}

/** Show the modal progress dialog while a network git action is in flight. */
function openSyncDialog(title: string, detail: string): void {
  const dlg = $<HTMLDialogElement>('#sync-dialog');
  $('#sync-title').textContent = title;
  $('#sync-detail').textContent = detail;
  if (!dlg.open) dlg.showModal();
}

function closeSyncDialog(): void {
  const dlg = $<HTMLDialogElement>('#sync-dialog');
  if (dlg.open) dlg.close();
}

// The git process keeps running regardless, so Escape must not dismiss the
// progress dialog and leave the user without feedback.
$('#sync-dialog').addEventListener('cancel', (ev) => ev.preventDefault());

/** Run a network git action, surfacing git's error and reloading on success. */
async function runSync(route: '/push' | '/pull', body: unknown): Promise<void> {
  const rs = remoteStatus;
  if (route === '/pull') {
    const detail = rs?.upstream ? `${rs.upstream} into ${rs.currentBranch ?? 'HEAD'}` : '';
    openSyncDialog('Pulling…', detail);
  }
  try {
    await api(route, body);
    await refresh();
  } catch (err) {
    alert(`${route === '/push' ? 'Push' : 'Pull'} failed:\n${String(err)}`);
  } finally {
    closeSyncDialog();
  }
}

/**
 * Push, prompting for a remote when several exist and none is the upstream.
 * `force` adds `--force-with-lease` (shift-click, or accepting the offer after a
 * rejected non-fast-forward push).
 */
async function doPush(force = false): Promise<void> {
  const rs = remoteStatus;
  if (!rs) return;
  if (rs.remotes.length === 0) {
    alert('No remote configured. Add one with `git remote add <name> <url>`.');
    return;
  }
  let remote: string | undefined;
  if (!rs.upstream && rs.remotes.length > 1) {
    remote = (await pickRemote('Push to which remote?')) ?? undefined;
    if (!remote) return;
  }
  const branch = rs.currentBranch ?? 'HEAD';
  const dest = remote ?? rs.upstream ?? 'a new upstream';
  openSyncDialog(
    force ? 'Force-pushing…' : 'Pushing…',
    `${branch} → ${dest}${rs.upstream ? '' : ' (setting upstream)'}`,
  );
  try {
    await api('/push', { remote, force });
    await refresh();
    closeSyncDialog();
  } catch (err) {
    // Close before the retry prompt / alert so they aren't stacked behind the spinner.
    closeSyncDialog();
    const message = String(err);
    if (!force && /non-fast-forward|\[rejected\]|fetch first/i.test(message)) {
      const branchName = rs.currentBranch ?? 'this branch';
      if (confirm(`Push rejected: the remote has commits you don't have.\n\nForce-push ${branchName} with --force-with-lease?`)) {
        await doPush(true);
      }
      return;
    }
    alert(`Push failed:\n${message}`);
  }
}

async function doPull(): Promise<void> {
  const rs = remoteStatus;
  if (!rs) return;
  if (!rs.upstream) {
    alert('No upstream configured. Push this branch first to set one.');
    return;
  }
  await runSync('/pull', {});
}

/** Modal remote chooser; resolves to the chosen name or null when cancelled. */
function pickRemote(subtitle: string): Promise<string | null> {
  const dlg = $<HTMLDialogElement>('#remote-dialog');
  $('#remote-subtitle').textContent = subtitle;
  const list = $('#remote-list');
  list.replaceChildren();
  return new Promise((resolve) => {
    const finish = (value: string | null): void => {
      cancel.removeEventListener('click', onCancel);
      dlg.removeEventListener('cancel', onCancel);
      dlg.close();
      resolve(value);
    };
    const onCancel = (): void => finish(null);
    const cancel = $<HTMLButtonElement>('#remote-cancel');
    cancel.addEventListener('click', onCancel);
    dlg.addEventListener('cancel', onCancel);
    for (const r of remoteStatus?.remotes ?? []) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn remote-choice';
      btn.innerHTML = `<span class="remote-name">${esc(r.name)}</span><span class="remote-url muted">${esc(r.url)}</span>`;
      btn.addEventListener('click', () => finish(r.name));
      list.appendChild(btn);
    }
    dlg.showModal();
  });
}

$('#btn-push').addEventListener('click', (ev) => void doPush(ev.shiftKey));
$('#btn-pull').addEventListener('click', () => void doPull());

// Selection: click a dot/label — any SVG element tagged with data-hash.
// Clicking empty SVG space clears the selection.
const graphScroll = $('#graph-scroll');

/** The branch pill under a graph click, if any. Only local and remote branch
 * pills act on a double click; head/tag/stash chips and the "+N" badge don't. */
function branchPillTarget(ev: Event): { kind: 'local' | 'remote'; name: string } | null {
  const node = (ev.target as Element).closest('[data-kind], [data-name]') as SVGElement | null;
  const kind = node?.dataset.kind;
  const name = node?.dataset.name ?? '';
  if (!name || (kind !== 'local' && kind !== 'remote')) return null;
  return { kind, name };
}

/** Check out the branch behind a pill; a no-op when it is already checked out. */
function checkoutBranchPill(pill: { kind: 'local' | 'remote'; name: string }): void {
  const currentBranch = lastResponse?.state?.headBranch ?? '';
  if (pill.kind === 'local') {
    if (pill.name === currentBranch) return;
    void checkout(pill.name);
  } else {
    const local = remoteLocalName(pill.name);
    if (!local || local === currentBranch) return;
    void checkout(pill.name, true);
  }
}

// A double click on a branch pill checks it out. The browser never delivers the
// native dblclick over a pill: the first click's renderCached() rebuilds the
// whole SVG, so the two clicks of the gesture land on different elements and
// dblclick is only dispatched when both clicks share a target. Recognize the
// pair manually instead — same pill, within the usual double-click window.
const DBL_CLICK_MS = 500;
let lastPillClick: { key: string; at: number } | null = null;

$svg('#graph-svg').addEventListener('click', (ev) => {
  const el = ev.target as SVGElement;
  const hash = el.dataset?.hash ?? null;
  const pill = branchPillTarget(ev);
  const now = performance.now();
  const key = pill ? `${pill.kind}\u0000${pill.name}` : '';
  const repeated =
    pill !== null && lastPillClick !== null && lastPillClick.key === key && now - lastPillClick.at < DBL_CLICK_MS;
  lastPillClick = pill ? { key, at: now } : null;
  if (repeated && pill) {
    lastPillClick = null; // Don't let a third fast click re-trigger the checkout.
    checkoutBranchPill(pill);
    return;
  }
  // Clicking the selected row again clears the selection.
  selectedHash = hash === selectedHash ? null : hash;
  renderCached();
});

// Ctrl+wheel zooms about the cursor; plain wheel keeps scrolling the pane.
graphScroll.addEventListener(
  'wheel',
  (ev) => {
    if (!ev.ctrlKey) return;
    ev.preventDefault();
    const prev = zoom;
    const next = Math.min(3, Math.max(0.3, prev * (ev.deltaY < 0 ? 1.1 : 0.9)));
    if (next === prev) return;
    // Keep the point under the cursor fixed while scaling.
    const rect = graphScroll.getBoundingClientRect();
    const cx = ev.clientX - rect.left + graphScroll.scrollLeft;
    const cy = ev.clientY - rect.top + graphScroll.scrollTop;
    panX = cx - ((cx - panX) * next) / prev;
    panY = cy - ((cy - panY) * next) / prev;
    zoom = next;
    applyTransform();
  },
  { passive: false },
);

// --- Right-click context menu: create branch/tag, delete branch/tag ---

interface ContextTarget {
  kind: 'commit' | 'local' | 'remote' | 'tag' | 'stash' | 'empty';
  hash: string | null;
  name?: string;
  isHead?: boolean;
}

const contextMenu = $('#context-menu');

function closeContextMenu(): void {
  contextMenu.hidden = true;
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Clipboard API needs a secure context; fall back for plain HTTP.
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
  } finally {
    ta.remove();
  }
}

function menuTitle(target: ContextTarget): string {
  if (target.kind === 'empty') return 'Repository';
  if (target.kind === 'stash') return `Stash ${target.name ?? ''}`;
  if (target.hash && (lastResponse?.commits ?? []).some((c) => c.hash === target.hash && c.isStash)) {
    return `Stash ${target.hash.slice(0, 8)}`;
  }
  if (target.kind === 'commit' || target.hash === null) return `Commit ${target.hash?.slice(0, 8) ?? ''}`;
  return `${target.kind} ${target.name ?? ''}`;
}

interface MenuItem {
  label?: string;
  action?: () => void;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
}

function buildMenu(target: ContextTarget): MenuItem[] {
  const items: MenuItem[] = [];
  const hash = target.hash;
  const isStash =
    target.kind === 'stash' ||
    (hash !== null && (lastResponse?.commits ?? []).some((c) => c.hash === hash && c.isStash));
  if (isStash && hash) {
    items.push({ label: 'Apply stash — keep the entry', action: () => void applyStash(hash) });
    items.push({ label: 'Apply stash & drop it', action: () => void popStash(hash) });
    items.push({ label: 'Drop stash', danger: true, action: () => void dropStash(hash) });
    return items;
  }
  if (hash) {
    items.push({ label: 'Create branch here…', action: () => openNameDialog('branch', hash) });
    items.push({ label: 'Create tag here…', action: () => openNameDialog('tag', hash) });
  }
  const name = target.name ?? '';
  const currentBranch = lastResponse?.state?.headBranch ?? '';
  const detached = lastResponse?.state?.detachedHead ?? false;
  const commit = hash ? (lastResponse?.commits ?? []).find((c) => c.hash === hash) : undefined;
  // Tip of the checked-out branch already contains this commit — nothing to pick.
  const isHeadTip = target.isHead ?? commit?.refs.some((r) => r.kind === 'head') ?? false;
  const short = hash?.slice(0, 8) ?? '';
  if (hash && currentBranch && !detached) {
    if (!isHeadTip) {
      items.push({ separator: true });
      if (commit && commit.parents.length >= 2) {
        commit.parents.forEach((_p, i) => {
          items.push({
            label: `Cherry-pick ${short} onto ${currentBranch} (-m ${i + 1})`,
            action: () => void cherryPickFromMenu(hash, i + 1),
          });
        });
      } else {
        items.push({ label: `Cherry-pick ${short} onto ${currentBranch}`, action: () => void cherryPickFromMenu(hash) });
        items.push({
          label: `Cherry-pick ${short} onto ${currentBranch} (record source -x)`,
          action: () => void cherryPickFromMenu(hash, undefined, true),
        });
      }
      if (INTERACTIVE_REBASE_ENABLED) {
        items.push({
          label: `Interactive rebase onto ${short}…`,
          action: () => void openRebaseDialog(hash),
        });
      }
    }
    // Reverting the tip is the common case, so this stays available at HEAD.
    items.push({ separator: true });
    if (commit && commit.parents.length >= 2) {
      commit.parents.forEach((_p, i) => {
        items.push({
          label: `Revert ${short} (-m ${i + 1})`,
          action: () => void revertFromMenu(hash, i + 1),
        });
      });
    } else {
      items.push({ label: `Revert ${short}`, action: () => void revertFromMenu(hash) });
    }
  }
  if ((target.kind === 'local' || target.kind === 'remote' || target.kind === 'tag') && name) {
    items.push({ separator: true });
    items.push({ label: 'Copy name', action: () => void copyToClipboard(name) });
  }
  if (target.kind === 'local' && name && name !== currentBranch && !target.isHead) {
    items.push({ separator: true });
    items.push({ label: `Checkout ${name}`, action: () => void checkout(name) });
    if (currentBranch && !detached) {
      items.push({ label: `Merge ${name} into ${currentBranch}`, action: () => void mergeIntoCurrent(name) });
      items.push({ label: `Rebase ${currentBranch} onto ${name}`, action: () => void rebaseOntoBranch(name) });
    }
    items.push({ label: `Delete branch ${name}`, danger: true, action: () => void deleteBranch(name, false) });
  } else if (target.kind === 'remote' && name) {
    const local = remoteLocalName(name);
    items.push({ separator: true });
    if (local && local !== currentBranch) {
      items.push({ label: `Checkout ${local} (tracking ${name})`, action: () => void checkout(name, true) });
    }
    if (currentBranch && !detached) {
      items.push({ label: `Merge ${name} into ${currentBranch}`, action: () => void mergeIntoCurrent(name) });
      items.push({ label: `Rebase ${currentBranch} onto ${name}`, action: () => void rebaseOntoBranch(name) });
    }
    items.push({ label: `Delete remote branch ${name}`, danger: true, action: () => void deleteBranch(name, true) });
  } else if (target.kind === 'tag' && name) {
    items.push({ separator: true });
    items.push({ label: `Delete tag ${name}`, danger: true, action: () => void deleteTag(name) });
  }
  if (hash && target.kind !== 'remote') {
    items.push({ separator: true });
    items.push({ label: 'Reset current branch to here', disabled: true });
    items.push({ label: 'Soft — keep changes staged', action: () => void resetTo(hash, 'soft') });
    items.push({ label: 'Mixed — keep changes unstaged', action: () => void resetTo(hash, 'mixed') });
    items.push({ label: 'Hard — discard all changes', danger: true, action: () => void resetTo(hash, 'hard') });
  }
  return items;
}

function showContextMenu(target: ContextTarget, x: number, y: number): void {
  const items = buildMenu(target);
  if (items.length === 0) return;
  contextMenu.replaceChildren();
  const head = document.createElement('div');
  head.className = 'ctx-head';
  head.textContent = menuTitle(target);
  contextMenu.appendChild(head);
  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      contextMenu.appendChild(sep);
      continue;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = item.label ?? '';
    if (item.danger) btn.classList.add('danger');
    if (item.disabled || !item.action) btn.disabled = true;
    if (item.action) {
      btn.addEventListener('click', () => {
        closeContextMenu();
        item.action?.();
      });
    }
    contextMenu.appendChild(btn);
  }
  contextMenu.hidden = false;
  const rect = contextMenu.getBoundingClientRect();
  const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
  contextMenu.style.left = `${left}px`;
  contextMenu.style.top = `${top}px`;
}

function targetFromSvg(el: Element | null): ContextTarget {
  const node = el?.closest('[data-kind], [data-hash]') as SVGElement | null;
  const kind = node?.dataset.kind;
  const hash = node?.dataset.hash ?? null;
  const name = node?.dataset.name;
  if (kind && kind !== 'head' && name) {
    return { kind: kind as 'local' | 'remote' | 'tag' | 'stash', hash, name };
  }
  if (hash) return { kind: 'commit', hash };
  return { kind: 'empty', hash: null };
}

$svg('#graph-svg').addEventListener('contextmenu', (ev) => {
  ev.preventDefault();
  showContextMenu(targetFromSvg(ev.target as Element), ev.clientX, ev.clientY);
});

// Delegated: the changed-file list is rendered after the pane's innerHTML is set,
// so bind on the pane rather than on each row as it appears.
$('#detail-pane').addEventListener('click', (ev) => {
  const target = ev.target as Element;
  const viewBtn = target.closest('button.view-file');
  if (viewBtn instanceof HTMLButtonElement) {
    const commit = (lastResponse?.commits ?? []).find((c) => c.hash === selectedHash);
    void openCodeViewer(viewBtn.dataset.path ?? '', commit?.hash ?? null);
    return;
  }
  const btn = target.closest('button.file-row');
  if (!(btn instanceof HTMLButtonElement)) return;
  if (btn.dataset.submodule === 'true') {
    openSubprojectDialog(btn.dataset.path ?? '');
    return;
  }
  openDiffDialog(btn.dataset.path ?? '', btn.dataset.oldPath ?? '');
});

$('#detail-pane').addEventListener('contextmenu', (ev) => {
  const li = (ev.target as Element).closest('li[data-branch]');
  if (!li) return;
  ev.preventDefault();
  const name = li.getAttribute('data-branch') ?? '';
  const info = (lastResponse?.state?.branches ?? []).find((b) => b.name === name);
  showContextMenu(
    { kind: info?.isRemote ? 'remote' : 'local', hash: info?.hash ?? null, name, isHead: info?.isHead },
    ev.clientX,
    ev.clientY,
  );
});

document.addEventListener('pointerdown', (ev) => {
  if (!contextMenu.hidden && !contextMenu.contains(ev.target as Node)) closeContextMenu();
});
window.addEventListener('resize', closeContextMenu);
graphScroll.addEventListener('scroll', closeContextMenu);

async function rebaseOntoBranch(name: string): Promise<void> {
  const branch = lastResponse?.state?.headBranch ?? 'the current branch';
  if (!confirm(`Rebase ${branch} onto ${name}?`)) return;
  try {
    await api('/rebase', { onto: name });
    await refresh();
  } catch (err) {
    alert(`Rebase failed:\n${String(err)}`);
  }
}

async function cherryPickFromMenu(hash: string, mainline?: number, record?: boolean): Promise<void> {
  const branch = lastResponse?.state?.headBranch ?? 'the current branch';
  const what = mainline !== undefined ? `commit ${hash.slice(0, 8)} (-m ${mainline})` : `commit ${hash.slice(0, 8)}`;
  if (!confirm(`Cherry-pick ${what} onto ${branch}?`)) return;
  try {
    await api('/cherry-pick', { ref: hash, mainline, record });
    await refresh();
  } catch (err) {
    alert(`Cherry-pick failed:\n${String(err)}`);
  }
}

async function revertFromMenu(hash: string, mainline?: number): Promise<void> {
  const branch = lastResponse?.state?.headBranch ?? 'the current branch';
  const what = mainline !== undefined ? `commit ${hash.slice(0, 8)} (-m ${mainline})` : `commit ${hash.slice(0, 8)}`;
  if (!confirm(`Revert ${what} on ${branch}? This creates a new commit undoing its changes.`)) return;
  try {
    await api('/revert', { ref: hash, mainline });
    await refresh();
  } catch (err) {
    alert(`Revert failed:\n${String(err)}`);
  }
}

async function mergeIntoCurrent(name: string): Promise<void> {
  const branch = lastResponse?.state?.headBranch ?? 'the current branch';
  if (!confirm(`Merge ${name} into ${branch}?`)) return;
  try {
    await api('/merge', { ref: name });
    await refresh();
  } catch (err) {
    alert(`Merge failed:\n${String(err)}`);
  }
}

async function deleteBranch(name: string, remote: boolean): Promise<void> {
  const noun = remote ? `remote branch "${name}"` : `branch "${name}"`;
  if (!confirm(`Delete ${noun}?`)) return;
  try {
    await api('/branch-delete', { name, remote });
    await refresh();
  } catch (err) {
    alert(`Delete failed:\n${String(err)}`);
  }
}

async function deleteTag(name: string): Promise<void> {
  if (!confirm(`Delete tag "${name}"?`)) return;
  try {
    await api('/tag-delete', { name });
    await refresh();
  } catch (err) {
    alert(`Delete failed:\n${String(err)}`);
  }
}

async function applyStash(hash: string): Promise<void> {
  try {
    await api('/stash-apply', { hash });
    await refresh();
  } catch (err) {
    alert(`Apply failed:\n${String(err)}`);
  }
}

async function popStash(hash: string): Promise<void> {
  try {
    await api('/stash-apply', { hash });
    await api('/stash-drop', { hash });
    selectedHash = null;
    await refresh();
  } catch (err) {
    alert(`Pop failed:\n${String(err)}`);
  }
}

async function dropStash(hash: string): Promise<void> {
  if (!confirm('Drop this stash entry? The saved changes are discarded.')) return;
  try {
    await api('/stash-drop', { hash });
    selectedHash = null;
    await refresh();
  } catch (err) {
    alert(`Drop failed:\n${String(err)}`);
  }
}

/** Custom confirm dialog that names the reset mode and target commit. */
function confirmReset(mode: ResetMode, hash: string): Promise<boolean> {
  const dlg = $<HTMLDialogElement>('#reset-dialog');
  $('#reset-summary').innerHTML =
    `Reset the checked-out branch to <code>${esc(hash.slice(0, 8))}</code> with <b>--${mode}</b>.`;
  const hardWarn = mode === 'hard';
  $('#reset-warning').hidden = !hardWarn;
  $<HTMLButtonElement>('#reset-confirm').textContent = `Reset --${mode}`;
  $<HTMLButtonElement>('#reset-confirm').classList.toggle('btn-danger', hardWarn);
  return new Promise((resolve) => {
    const confirmBtn = $<HTMLButtonElement>('#reset-confirm');
    const cancelBtn = $<HTMLButtonElement>('#reset-cancel');
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

async function resetTo(hash: string, mode: ResetMode): Promise<void> {
  if (!(await confirmReset(mode, hash))) return;
  try {
    await api('/reset', { mode, ref: hash });
    selectedHash = null;
    await refresh();
  } catch (err) {
    alert(`Reset failed:\n${String(err)}`);
  }
}

// --- Create branch / tag dialog ---

type NameMode = 'branch' | 'tag';
let nameMode: NameMode = 'branch';
let nameRef = '';

function openNameDialog(mode: NameMode, ref: string): void {
  nameMode = mode;
  nameRef = ref;
  $('#name-title').textContent = mode === 'branch' ? 'Create branch' : 'Create tag';
  $('#name-subtitle').textContent = `At commit ${ref.slice(0, 8)}`;
  $('#name-error').textContent = '';
  const input = $<HTMLInputElement>('#name-input');
  input.value = '';
  $<HTMLButtonElement>('#name-submit').textContent = mode === 'branch' ? 'Create & checkout' : 'Create tag';
  $<HTMLDialogElement>('#name-dialog').showModal();
  input.focus();
}

// Submit (not click) so Enter in the name field creates the ref instead of
// implicitly activating Cancel, the first submit button.
$('#name-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const name = $<HTMLInputElement>('#name-input').value.trim();
  if (!name) {
    $('#name-error').textContent = 'Name required';
    return;
  }
  void (async () => {
    try {
      if (nameMode === 'branch') await api('/branch-create', { name, ref: nameRef });
      else await api('/tag-create', { name, ref: nameRef });
      $<HTMLDialogElement>('#name-dialog').close();
      await refresh();
    } catch (err) {
      $('#name-error').textContent = String(err);
    }
  })();
});

$('#name-cancel').addEventListener('click', () => {
  $<HTMLDialogElement>('#name-dialog').close();
});

// --- Settings dialog: AI providers, review rules, Git hosting ---

/** Provider list being edited; secrets stay represented by `hasKey`. */
let settingsProviders: AiProviderConfig[] = [];
let settingsActiveProviderId: string | null = null;
/** Newly typed provider keys, keyed by provider id; sent only when non-empty. */
const settingsNewKeys = new Map<string, string>();

function renderProviderList(): void {
  const ul = $('#settings-providers');
  if (settingsProviders.length === 0) {
    ul.innerHTML = '<li class="provider-empty muted">No providers yet. Add one below.</li>';
    return;
  }
  ul.innerHTML = settingsProviders
    .map(
      (p, i) => `
      <li class="provider-item" data-index="${i}">
        <label class="provider-active">
          <input type="radio" name="active-provider" ${p.id === settingsActiveProviderId ? 'checked' : ''} />
          <span class="provider-active-label">active</span>
        </label>
        <div class="provider-fields">
          <div class="provider-row">
            <input type="text" class="pf-name" placeholder="Name" value="${esc(p.name)}" />
            <input type="text" class="pf-model" placeholder="Model (e.g. qwen2.5-coder:7b)" value="${esc(p.model)}" />
          </div>
          <input type="text" class="pf-url" placeholder="Base URL (…/v1)" value="${esc(p.baseUrl)}" />
          <input type="password" class="pf-key" autocomplete="off"
            placeholder="${p.hasKey ? 'Token saved — leave blank to keep' : 'API token (optional for local models)'}" />
          <div class="provider-row">
            <label class="pf-small">Protocol
              <select class="pf-protocol">
                <option value="auto">auto</option>
                <option value="native">native</option>
                <option value="react">react</option>
                <option value="json">json</option>
                <option value="none">none</option>
              </select>
            </label>
            <label class="pf-small">Context
              <input type="number" class="pf-context" min="512" value="${p.contextWindow}" />
            </label>
            <label class="pf-small">Max tokens
              <input type="number" class="pf-maxtokens" min="1" value="${p.maxTokens}" />
            </label>
            <label class="pf-small">Max steps
              <input type="number" class="pf-maxsteps" min="1" value="${p.maxSteps}" />
            </label>
          </div>
          <div class="provider-row">
            <label class="pf-small">Result chars
              <input type="number" class="pf-resultchars" min="200" value="${p.toolResultChars}" />
            </label>
            <label class="pf-small">Temperature
              <input type="number" class="pf-temp" step="0.1" min="0" value="${p.temperature}" />
            </label>
            <label class="pf-checkbox">
              <input type="checkbox" class="pf-stream" ${p.stream ? 'checked' : ''} /> Stream
            </label>
            <button type="button" class="btn pf-remove">Remove</button>
          </div>
          <p class="muted hint pf-detected">${
            p.detectedProtocol ? `Last successful protocol: ${esc(p.detectedProtocol)}` : ''
          }</p>
        </div>
      </li>`,
    )
    .join('');

  const selects = ul.querySelectorAll<HTMLSelectElement>('.pf-protocol');
  settingsProviders.forEach((p, i) => {
    const sel = selects[i];
    if (sel) sel.value = p.toolProtocol;
  });
}

/** Pull the current DOM values back into `settingsProviders`. */
function readProviderInputs(): void {
  const items = document.querySelectorAll<HTMLLIElement>('#settings-providers .provider-item');
  items.forEach((li) => {
    const i = Number(li.dataset.index);
    const p = settingsProviders[i];
    if (!p) return;
    const q = <T extends HTMLElement>(sel: string): T | null => li.querySelector<T>(sel);
    p.name = q<HTMLInputElement>('.pf-name')?.value.trim() || p.name;
    p.model = q<HTMLInputElement>('.pf-model')?.value.trim() ?? p.model;
    p.baseUrl = q<HTMLInputElement>('.pf-url')?.value.trim() || p.baseUrl;
    p.contextWindow = Number(q<HTMLInputElement>('.pf-context')?.value) || p.contextWindow;
    p.maxTokens = Number(q<HTMLInputElement>('.pf-maxtokens')?.value) || p.maxTokens;
    p.maxSteps = Number(q<HTMLInputElement>('.pf-maxsteps')?.value) || p.maxSteps;
    p.toolResultChars =
      Number(q<HTMLInputElement>('.pf-resultchars')?.value) || p.toolResultChars;
    p.temperature = Number(q<HTMLInputElement>('.pf-temp')?.value) || p.temperature;
    p.stream = q<HTMLInputElement>('.pf-stream')?.checked ?? p.stream;
    const proto = q<HTMLSelectElement>('.pf-protocol')?.value;
    if (proto === 'auto' || proto === 'native' || proto === 'react' || proto === 'json' || proto === 'none') {
      p.toolProtocol = proto;
    }
    const radio = li.querySelector<HTMLInputElement>('input[name="active-provider"]');
    if (radio?.checked) settingsActiveProviderId = p.id;
  });
  // The key input is only sent when the user typed a new value.
  items.forEach((li) => {
    const i = Number(li.dataset.index);
    const p = settingsProviders[i];
    const key = li.querySelector<HTMLInputElement>('.pf-key')?.value.trim();
    if (p && key) settingsNewKeys.set(p.id, key);
  });
}

function showSettingsTab(tab: string): void {
  document.querySelectorAll<HTMLButtonElement>('.settings-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  document.querySelectorAll<HTMLElement>('.settings-panel').forEach((p) => {
    p.hidden = p.dataset.panel !== tab;
  });
  // Git hosting has its own per-forge Test buttons inside the panel.
  $('#settings-test').hidden = tab !== 'ai';
  if (tab === 'theme') applyTheme(currentTheme());
}

async function openSettingsDialog(): Promise<void> {
  const dlg = $<HTMLDialogElement>('#settings-dialog');
  const status = $('#settings-status');
  status.textContent = '';
  settingsNewKeys.clear();
  try {
    const s = await api<AppSettings>('/settings', undefined, { scoped: false });
    settingsProviders = s.ai.providers;
    settingsActiveProviderId = s.ai.activeProviderId;
    renderProviderList();

    $<HTMLTextAreaElement>('#settings-review-instructions').value = s.review.instructions;
    $<HTMLSelectElement>('#settings-review-severity').value = s.review.severityThreshold;
    $<HTMLInputElement>('#settings-review-maxcomments').value = String(s.review.maxComments);
    $<HTMLInputElement>('#settings-review-language').value = s.review.language;
    $<HTMLInputElement>('#settings-review-maxsteps').value = String(s.review.maxSteps);
    $<HTMLTextAreaElement>('#settings-review-ignore').value = s.review.ignoreGlobs.join('\n');
    $<HTMLInputElement>('#settings-review-batch').checked = s.review.batchByFile;

    $<HTMLTextAreaElement>('#settings-commit-instructions').value = s.commit.instructions;
    $<HTMLInputElement>('#settings-commit-language').value = s.commit.language;
    $<HTMLInputElement>('#settings-commit-maxdiff').value = String(s.commit.maxDiffChars);
    $<HTMLInputElement>('#settings-commit-history').checked = s.commit.includeHistory;

    $<HTMLInputElement>('#settings-gitlab-url').value = s.gitlab.baseUrl;
    $<HTMLInputElement>('#settings-gitlab-token').value = '';
    $<HTMLInputElement>('#settings-gitlab-project').value = s.gitlab.projectId;
    $('#settings-gitlab-note').textContent = s.gitlab.hasToken
      ? 'A token is saved. Leave the field blank to keep it.'
      : 'No token saved yet.';

    $<HTMLInputElement>('#settings-github-url').value = s.github.baseUrl;
    $<HTMLInputElement>('#settings-github-token').value = '';
    $<HTMLInputElement>('#settings-github-repo').value = s.github.repo;
    $('#settings-github-note').textContent = s.github.hasToken
      ? 'A token is saved. Leave the field blank to keep it.'
      : 'No token saved yet.';
    $<HTMLSelectElement>('#settings-forge').value = s.forge;
  } catch (err) {
    status.textContent = String(err);
  }
  buildThemeOptions();
  showSettingsTab('ai');
  dlg.showModal();
}

function collectSettingsPatch(): Record<string, unknown> {
  readProviderInputs();
  const tokenValue = $<HTMLInputElement>('#settings-gitlab-token').value;
  const githubTokenValue = $<HTMLInputElement>('#settings-github-token').value;
  const providers = settingsProviders.map((p) => {
    const out: Record<string, unknown> = {
      id: p.id,
      name: p.name,
      baseUrl: p.baseUrl,
      model: p.model,
      contextWindow: p.contextWindow,
      maxTokens: p.maxTokens,
      temperature: p.temperature,
      toolProtocol: p.toolProtocol,
      detectedProtocol: p.detectedProtocol,
      toolResultChars: p.toolResultChars,
      maxSteps: p.maxSteps,
      stream: p.stream,
    };
    const key = settingsNewKeys.get(p.id);
    if (key) out.apiKey = key;
    return out;
  });
  return {
    ai: { providers, activeProviderId: settingsActiveProviderId },
    review: {
      instructions: $<HTMLTextAreaElement>('#settings-review-instructions').value,
      severityThreshold: $<HTMLSelectElement>('#settings-review-severity').value,
      maxComments: Number($<HTMLInputElement>('#settings-review-maxcomments').value) || 0,
      language: $<HTMLInputElement>('#settings-review-language').value.trim() || 'English',
      maxSteps: Number($<HTMLInputElement>('#settings-review-maxsteps').value) || 8,
      ignoreGlobs: $<HTMLTextAreaElement>('#settings-review-ignore')
        .value.split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
      batchByFile: $<HTMLInputElement>('#settings-review-batch').checked,
    },
    commit: {
      instructions: $<HTMLTextAreaElement>('#settings-commit-instructions').value,
      language: $<HTMLInputElement>('#settings-commit-language').value.trim() || 'English',
      includeHistory: $<HTMLInputElement>('#settings-commit-history').checked,
      maxDiffChars: Number($<HTMLInputElement>('#settings-commit-maxdiff').value) || 12000,
    },
    gitlab: {
      baseUrl: $<HTMLInputElement>('#settings-gitlab-url').value.trim(),
      // Omit when blank so an existing token is preserved.
      ...(tokenValue ? { token: tokenValue } : {}),
      projectId: $<HTMLInputElement>('#settings-gitlab-project').value.trim(),
    },
    github: {
      baseUrl: $<HTMLInputElement>('#settings-github-url').value.trim(),
      ...(githubTokenValue ? { token: githubTokenValue } : {}),
      repo: $<HTMLInputElement>('#settings-github-repo').value.trim(),
    },
    forge: ($<HTMLSelectElement>('#settings-forge').value as 'auto' | 'gitlab' | 'github'),
  };
}

$('#btn-settings').addEventListener('click', () => {
  closeMoreMenu();
  void openSettingsDialog();
});

document.querySelectorAll<HTMLButtonElement>('.settings-tab').forEach((btn) => {
  btn.addEventListener('click', () => showSettingsTab(btn.dataset.tab ?? 'ai'));
});

$('#settings-add-provider').addEventListener('click', () => {
  readProviderInputs();
  const id = `p${Date.now().toString(36)}`;
  settingsProviders.push({
    id,
    name: 'New provider',
    baseUrl: 'http://localhost:11434/v1',
    model: '',
    hasKey: false,
    contextWindow: 8192,
    maxTokens: 1024,
    temperature: 0.1,
    toolProtocol: 'auto',
    detectedProtocol: null,
    toolResultChars: 2000,
    maxSteps: 8,
    stream: true,
  });
  if (!settingsActiveProviderId) settingsActiveProviderId = id;
  renderProviderList();
});

$('#settings-providers').addEventListener('click', (ev) => {
  const target = ev.target;
  if (!(target instanceof HTMLElement) || !target.classList.contains('pf-remove')) return;
  const li = target.closest<HTMLLIElement>('.provider-item');
  if (!li) return;
  readProviderInputs();
  const i = Number(li.dataset.index);
  const removed = settingsProviders[i];
  settingsProviders.splice(i, 1);
  if (removed && settingsActiveProviderId === removed.id) {
    settingsActiveProviderId = settingsProviders[0]?.id ?? null;
  }
  renderProviderList();
});

/** Persist the current dialog state and refresh the provider list from the reply. */
async function persistSettings(): Promise<void> {
  const s = await api<AppSettings>('/settings', collectSettingsPatch(), { scoped: false });
  settingsProviders = s.ai.providers;
  settingsActiveProviderId = s.ai.activeProviderId;
  renderProviderList();
}

$('#settings-save').addEventListener('click', (ev) => {
  ev.preventDefault();
  const status = $('#settings-status');
  status.textContent = 'Saving…';
  void (async () => {
    try {
      await persistSettings();
      status.textContent = 'Saved.';
    } catch (err) {
      status.textContent = String(err);
    }
  })();
});

$('#settings-test').addEventListener('click', (ev) => {
  ev.preventDefault();
  const status = $('#settings-status');
  void (async () => {
    try {
      readProviderInputs();
      const active = settingsProviders.find((p) => p.id === settingsActiveProviderId);
      if (!active) {
        status.textContent = 'Add a provider first.';
        return;
      }
      await persistSettings();
      status.textContent = 'Testing AI endpoint…';
      const res = await api<{ reply: string }>(
        '/settings/test-ai',
        { providerId: active.id },
        { scoped: false },
      );
      status.textContent = `AI OK: ${res.reply}`;
    } catch (err) {
      status.textContent = String(err);
    }
  })();
});

/** Shared handler for the per-forge Test buttons: persist first, then probe. */
function testForgeButton(forge: 'gitlab' | 'github', route: string, label: string): () => void {
  return () => {
    const status = $('#settings-status');
    void (async () => {
      try {
        status.textContent = `Testing ${label}…`;
        // Persist the edited fields first so the probe uses them.
        await persistSettings();
        const res = await api<{ username: string }>(route, forge === 'github' ? { forge } : {}, {
          scoped: false,
        });
        status.textContent = `${label} OK as ${res.username}.`;
      } catch (err) {
        status.textContent = String(err);
      }
    })();
  };
}

$('#settings-test-gitlab').addEventListener(
  'click',
  testForgeButton('gitlab', '/settings/test-gitlab', 'GitLab'),
);
$('#settings-test-github').addEventListener(
  'click',
  testForgeButton('github', '/settings/test-forge', 'GitHub'),
);

$('#settings-cancel').addEventListener('click', (ev) => {
  ev.preventDefault();
  $<HTMLDialogElement>('#settings-dialog').close();
});

// --- Code review tabs (one per open repository) ---

/** Per-repository review state, so several review tabs can coexist. */
interface ReviewTabState {
  repoId: string;
  repoPath: string;
  changes: ReviewChanges | null;
  job: ReviewJob | null;
  poll: number | undefined;
  /** Debounce handle for persisting comment-body edits. */
  saveTimer: number | undefined;
  /** Local edits/approval state that must survive a poll re-render, keyed by comment id. */
  edits: Map<string, { body: string; status: ReviewCommentStatus }>;
  /** Open merge requests, mirrored into the picker. */
  mrs: ReviewRequest[];
  /** Merge request iid currently selected in the picker (0 when none). */
  mrIid: number;
  /** Saved sessions for this repository, mirrored into the picker. */
  sessions: ReviewSession[];
  /** Whether rejected comments are revealed again in the queue. */
  showRejected: boolean;
  /** Comment ids with a post in flight, to prevent duplicate sends. */
  sending: Set<string>;
}

/** Review tabs keyed by the repository id they are bound to. */
const reviewTabs = new Map<string, ReviewTabState>();
/** Repository whose review tab is the visible view, or null for the graph view. */
let activeReviewId: string | null = null;

/** The review tab currently shown, if any. */
function activeReview(): ReviewTabState | null {
  return activeReviewId !== null ? reviewTabs.get(activeReviewId) ?? null : null;
}

const reviewView = $('#review-view');
const REVIEW_TABS_KEY = 'liana-review-tabs';
const REVIEW_ACTIVE_KEY = 'liana-review-active';

/** Short/long noun for a review tab's forge; defaults to GitLab for old sessions. */
function forgeLabels(forge: ForgeKind | undefined): { short: string; long: string; prefix: string } {
  return forge === 'github'
    ? { short: 'PR', long: 'pull request', prefix: '#' }
    : { short: 'MR', long: 'merge request', prefix: '!' };
}

/** Format a request number using the forge's convention (`!123` vs `#123`). */
function requestNumber(forge: ForgeKind | undefined, iid: number): string {
  return `${forgeLabels(forge).prefix}${iid}`;
}

/** Update the review toolbar wording (merge request vs pull request) for a tab. */
function paintForgeWording(state: ReviewTabState): void {
  if (activeReviewId !== state.repoId) return;
  const { short, long } = forgeLabels(state.changes?.forge);
  $('#review-mr-label').textContent = long.charAt(0).toUpperCase() + long.slice(1);
  $('#review-approve-mr').textContent = `Approve ${short}`;
}

/** Remember the open review tabs (by path) and which one was visible. */
function persistReviewTabs(): void {
  try {
    const paths = tabs.filter((t) => reviewTabs.has(t.id)).map((t) => t.path);
    localStorage.setItem(REVIEW_TABS_KEY, JSON.stringify(paths));
    const active = activeReviewId !== null ? reviewTabs.get(activeReviewId) : undefined;
    if (active) localStorage.setItem(REVIEW_ACTIVE_KEY, active.repoPath);
    else localStorage.removeItem(REVIEW_ACTIVE_KEY);
  } catch {
    // localStorage may be unavailable (private mode); review still works in-session.
  }
}

function readSavedReviewPaths(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(REVIEW_TABS_KEY) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

/** Best-effort flush of comment edits for every review tab when the page goes away. */
function flushReviewEdits(): void {
  for (const state of reviewTabs.values()) {
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
window.addEventListener('pagehide', flushReviewEdits);

function refreshSessionSelect(state: ReviewTabState): void {
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

async function loadReviewSessions(state: ReviewTabState): Promise<void> {
  try {
    const { sessions } = await reviewApi<{ sessions: ReviewSession[] }>(state, '/review/sessions');
    state.sessions = sessions;
    if (activeReviewId === state.repoId) refreshSessionSelect(state);
  } catch {
    // A failed listing leaves the previous picker contents in place.
  }
}

/** Restore a persisted session (or a live paused job) into the review view. */
async function restoreSession(state: ReviewTabState, sessionId: string): Promise<void> {
  if (!sessionId) return;
  const status = $('#review-status');
  if (activeReviewId === state.repoId) status.textContent = 'Restoring review…';
  window.clearTimeout(state.poll);
  try {
    const view = await reviewApi<ReviewSessionView>(state, '/review/session', { sessionId });
    applySessionView(state, view);
    if (view.job.state === 'running') {
      state.poll = window.setTimeout(() => void pollJob(state), 600);
    }
    if (activeReviewId === state.repoId) refreshSessionSelect(state);
  } catch (err) {
    if (activeReviewId === state.repoId) status.textContent = String(err);
  }
}

/** Push a loaded session into the review view's state and DOM. */
function applySessionView(state: ReviewTabState, view: ReviewSessionView): void {
  state.changes = view.changes;
  state.job = view.job;
  state.edits.clear();
  state.showRejected = false;
  for (const c of view.job.comments) {
    state.edits.set(c.id, { body: c.body, status: c.status });
  }
  if (activeReviewId !== state.repoId) return;
  paintForgeWording(state);
  $('#review-subtitle').textContent = `${requestNumber(view.changes.forge, view.changes.mr.iid)}: ${view.changes.mr.title} — ${view.changes.files.length} file(s)`;
  $('#review-approve-mr').hidden = false;
  renderJob(state, view.job);
  if (view.job.comments.length === 0) $('#review-queue-wrap').hidden = true;
}

function refreshMrSelect(state: ReviewTabState): void {
  const sel = $<HTMLSelectElement>('#review-mr-select');
  sel.innerHTML = state.mrs
    .map(
      (m) =>
        `<option value="${m.iid}">${requestNumber(state.changes?.forge, m.iid)} ${esc(m.draft ? 'Draft: ' : '')}${esc(m.title)} — ${esc(m.sourceBranch)}→${esc(m.targetBranch)}</option>`,
    )
    .join('');
  // Restore this tab's selection when it still exists, else keep the default.
  if (state.mrIid > 0 && state.mrs.some((m) => m.iid === state.mrIid)) {
    sel.value = String(state.mrIid);
  } else {
    state.mrIid = Number(sel.value) || 0;
  }
  $<HTMLButtonElement>('#review-generate').toggleAttribute('disabled', state.mrs.length === 0);
}

async function loadMergeRequests(state: ReviewTabState): Promise<void> {
  const status = $('#review-status');
  if (activeReviewId === state.repoId) status.textContent = 'Loading requests…';
  try {
    const { mrs } = await reviewApi<{ mrs: ReviewRequest[] }>(state, '/forge/mrs');
    state.mrs = mrs;
    if (activeReviewId !== state.repoId) return;
    refreshMrSelect(state);
    status.textContent = mrs.length === 0 ? 'No open requests.' : '';
  } catch (err) {
    if (activeReviewId !== state.repoId) return;
    status.textContent = String(err);
  }
}

/** Fetch the selected MR's changes; returns false when there is no selection. */
async function loadSelectedMr(fetchRefs = false): Promise<boolean> {
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
    if (activeReviewId !== state.repoId) return true;
    paintForgeWording(state);
    $('#review-subtitle').textContent = `${requestNumber(changes.forge, changes.mr.iid)}: ${changes.mr.title} — ${changes.files.length} file(s)`;
    $('#review-queue-wrap').hidden = true;
    $('#review-trace-wrap').hidden = true;
    $('#review-output-wrap').hidden = true;
    $('#review-progress').hidden = true;
    $('#review-cancel-job').hidden = true;
    $('#review-approve-mr').hidden = false;
    status.textContent = fetchResult?.error
      ? `Request commit not fetched: ${fetchResult.error} — repository tools may be limited`
      : '';
    return true;
  } catch (err) {
    status.textContent = String(err);
    return false;
  }
}

function renderTrace(job: ReviewJob): void {
  $('#review-trace-count').textContent = String(job.trace.length);
  const ol = $('#review-trace');
  ol.innerHTML = job.trace
    .map(
      (t) =>
        `<li><code>${esc(t.tool)}</code> <span class="muted">${esc(JSON.stringify(t.args))}</span>` +
        `<div class="trace-result">${esc(t.resultSummary)}</div>` +
        `<span class="muted">${t.durationMs}ms</span></li>`,
    )
    .join('');
}

/** A short diff excerpt around a comment's anchor, or '' when it can't be located. */
/** A comment's ±2-line diff window, pre-split for the inline Monaco excerpt. */
interface ExcerptWindow {
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

const EXCERPT_LINE_HEIGHT = 19;
const EXCERPT_MIN_HEIGHT = 56;
const EXCERPT_MAX_HEIGHT = 150;

/**
 * Locate a comment's anchor in its file diff and build a small old/new window
 * around it. Returns null when the file, its diff, or the anchor can't be found.
 */
function excerptWindow(state: ReviewTabState, c: ReviewComment): ExcerptWindow | null {
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
function commentExcerptHtml(state: ReviewTabState, c: ReviewComment): string {
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
let excerptHandles: CodeHandle[] = [];

/** Tear down every mounted excerpt editor (called before each queue rebuild). */
function disposeExcerptEditors(): void {
  for (const handle of excerptHandles) handle.dispose();
  excerptHandles = [];
}

/**
 * Upgrade each rendered excerpt placeholder to an inline Monaco diff. Remounts
 * on every queue rebuild, so previous handles are disposed first. When Monaco is
 * unavailable the placeholder's hand-rolled HTML stays in place.
 */
async function mountExcerptEditors(state: ReviewTabState, list: HTMLElement): Promise<void> {
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

function renderCommentQueue(state: ReviewTabState): void {
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
  if (activeReviewId === state.repoId) void mountExcerptEditors(state, list);
}

/** Record a comment's local status/body so a poll re-render preserves it. */
function setCommentStatus(state: ReviewTabState, c: ReviewComment, status: ReviewCommentStatus): void {
  c.status = status;
  const edit = state.edits.get(c.id) ?? { body: c.body, status };
  edit.body = c.body;
  edit.status = status;
  state.edits.set(c.id, edit);
}

/** Approve a comment: mark it, then post that comment alone to the MR. */
async function approveComment(state: ReviewTabState, id: string): Promise<void> {
  const c = state.job?.comments.find((x) => x.id === id);
  if (!c || c.status === 'posted' || state.sending.has(id)) return;
  state.sending.add(id);
  setCommentStatus(state, c, 'approved');
  if (activeReviewId === state.repoId) renderCommentQueue(state);
  void persistSessionEdits(state);
  try {
    await sendComment(state, id);
  } finally {
    state.sending.delete(id);
    if (activeReviewId === state.repoId) renderCommentQueue(state);
  }
}

/** Reject a comment: mark it and hide it from the queue. */
function rejectComment(state: ReviewTabState, id: string): void {
  const c = state.job?.comments.find((x) => x.id === id);
  if (!c) return;
  setCommentStatus(state, c, 'rejected');
  if (activeReviewId === state.repoId) renderCommentQueue(state);
  void persistSessionEdits(state);
}

/** Post a single approved comment and fold the result back into the queue. */
async function sendComment(state: ReviewTabState, id: string): Promise<void> {
  const job = state.job;
  const changes = state.changes;
  if (!job || !changes) return;
  const c = job.comments.find((x) => x.id === id);
  if (!c) return;
  const status = $('#review-status');
  const shown = activeReviewId === state.repoId;
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
    if (activeReviewId === state.repoId) {
      renderCommentQueue(state);
      status.textContent =
        c.status === 'posted' ? 'Comment posted.' : `Post failed: ${c.error ?? 'unknown error'}`;
    }
    void persistSessionEdits(state);
  } catch (err) {
    if (shown) status.textContent = String(err);
  }
}

function renderJob(state: ReviewTabState, job: ReviewJob): void {
  $('#review-progress').hidden = job.state !== 'running';
  $('#review-pause-job').hidden = job.state !== 'running';
  $('#review-resume-job').hidden = job.state !== 'paused';
  $('#review-cancel-job').hidden = job.state !== 'running' && job.state !== 'paused';
  $('#review-progress-text').textContent = `Step ${job.trace.length} · batch ${job.batchIndex}/${job.batchTotal}${
    job.protocol ? ` · ${job.protocol}` : ''
  }`;
  if (job.trace.length > 0) {
    $('#review-trace-wrap').hidden = false;
    renderTrace(job);
  }
  if (job.output) {
    $('#review-output-wrap').hidden = false;
    $<HTMLPreElement>('#review-output').textContent = job.output;
  }
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
async function pollJob(state: ReviewTabState): Promise<void> {
  if (!state.job) return;
  try {
    const { job } = await reviewApi<{ job: ReviewJob }>(state, '/review/status', { jobId: state.job.id });
    state.job = job;
    if (activeReviewId === state.repoId) renderJob(state, job);
    if (job.state === 'running') {
      state.poll = window.setTimeout(() => void pollJob(state), 800);
    } else {
      void loadReviewSessions(state);
    }
  } catch (err) {
    if (activeReviewId === state.repoId) $('#review-status').textContent = String(err);
  }
}

/** Persist local comment edits/approvals onto the stored session. */
async function persistSessionEdits(state: ReviewTabState): Promise<void> {
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
async function generateReview(): Promise<void> {
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
    $('#review-trace-wrap').hidden = true;
    $('#review-output-wrap').hidden = true;
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
function openReviewTab(): void {
  // Bind to the active repository; opening review with no repo is a no-op.
  if (!activeId) {
    alert('Open a repository first.');
    return;
  }
  // Re-opening for a repo that already has a review tab focuses it, keeping state.
  if (reviewTabs.has(activeId)) {
    activateReviewTab(activeId);
    return;
  }
  const tab = activeTab();
  if (!tab) return;
  const state: ReviewTabState = {
    repoId: activeId,
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
  reviewTabs.set(activeId, state);
  activeReviewId = activeId;
  resetReviewDom();
  refreshSessionSelect(state);
  persistReviewTabs();
  updateReviewVisibility();
  renderTabs();
  void loadMergeRequests(state);
  void loadSessionsAndMaybeRestore(state);
}

/** Clear the review view's DOM for a fresh tab. */
function resetReviewDom(): void {
  $('#review-subtitle').textContent = 'Review an open merge/pull request with AI.';
  $('#review-queue-wrap').hidden = true;
  $('#review-trace-wrap').hidden = true;
  $('#review-output-wrap').hidden = true;
  $('#review-progress').hidden = true;
  $('#review-pause-job').hidden = true;
  $('#review-resume-job').hidden = true;
  $('#review-approve-mr').hidden = true;
}

/** Repaint the review view from a tab's stored state when it becomes visible. */
function paintReview(state: ReviewTabState): void {
  refreshMrSelect(state);
  refreshSessionSelect(state);
  const changes = state.changes;
  paintForgeWording(state);
  $('#review-subtitle').textContent = changes
    ? `${requestNumber(changes.forge, changes.mr.iid)}: ${changes.mr.title} — ${changes.files.length} file(s)`
    : 'Review an open merge/pull request with AI.';
  $('#review-approve-mr').hidden = changes === null;
  $('#review-queue-wrap').hidden = true;
  $('#review-trace-wrap').hidden = true;
  $('#review-output-wrap').hidden = true;
  $('#review-progress').hidden = true;
  $('#review-pause-job').hidden = true;
  $('#review-resume-job').hidden = true;
  $('#review-cancel-job').hidden = true;
  $('#review-status').textContent = '';
  if (state.job) renderJob(state, state.job);
}

/** Load saved sessions; restore the newest one so a review survives a reload. */
async function loadSessionsAndMaybeRestore(state: ReviewTabState): Promise<void> {
  await loadReviewSessions(state);
  if (state.sessions.length > 0 && !state.job) {
    const newest = state.sessions[0];
    if (newest) await restoreSession(state, newest.id);
  }
}

/** Close a repository's review tab and, if it was visible, fall back to the graph. */
function closeReviewTab(repoId: string): void {
  const state = reviewTabs.get(repoId);
  if (!state) return;
  window.clearTimeout(state.poll);
  window.clearTimeout(state.saveTimer);
  // Only the visible tab owns mounted excerpt editors; drop them on close.
  if (activeReviewId === repoId) disposeExcerptEditors();
  reviewTabs.delete(repoId);
  if (activeReviewId === repoId) {
    activeReviewId = null;
    updateReviewVisibility();
    renderCached();
  }
  renderTabs();
  persistReviewTabs();
}

/** Toggle the columns and the review view to match `activeReviewId`. */
function updateReviewVisibility(): void {
  const shown = activeReviewId !== null;
  reviewView.hidden = !shown;
  $('#graph-wrap').hidden = shown;
  $('#detail-resizer').hidden = shown;
  $('#detail-pane').hidden = shown;
  const bound = activeReviewId !== null ? tabs.find((t) => t.id === activeReviewId) : undefined;
  $('#review-repo').textContent = bound ? ` · ${bound.name}` : '';
}

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
      $('#review-trace-wrap').hidden = true;
      $('#review-output-wrap').hidden = true;
      $('#review-progress').hidden = true;
      $('#review-pause-job').hidden = true;
      $('#review-resume-job').hidden = true;
      $('#review-cancel-job').hidden = true;
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
  if (submoduleDlg.open) {
    submoduleDlg.close();
    return;
  }
  if (aiConflictDlg.open) {
    aiConflictSeq++;
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
  if (selectedHash === null) return;
  selectedHash = null;
  renderCached();
});

// --- Resizable detail pane ---

const DETAIL_WIDTH_KEY = 'liana-detail-width';
const DETAIL_MIN = 200;
const DETAIL_MAX = 720;

function setDetailWidth(width: number): void {
  const main = document.querySelector('main');
  if (!main) return;
  const max = Math.min(DETAIL_MAX, Math.max(DETAIL_MIN, main.clientWidth - DETAIL_MIN));
  const clamped = Math.min(max, Math.max(DETAIL_MIN, width));
  document.documentElement.style.setProperty('--detail-width', `${clamped}px`);
  localStorage.setItem(DETAIL_WIDTH_KEY, String(clamped));
}

function initDetailResizer(): void {
  const resizer = $('#detail-resizer');
  const saved = Number(localStorage.getItem(DETAIL_WIDTH_KEY));
  if (Number.isFinite(saved) && saved > 0) setDetailWidth(saved);

  const onMove = (ev: PointerEvent) => {
    const main = document.querySelector('main');
    if (!main) return;
    const rect = main.getBoundingClientRect();
    setDetailWidth(rect.right - ev.clientX);
  };
  const onUp = () => {
    resizer.classList.remove('dragging');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  };
  resizer.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    resizer.classList.add('dragging');
    resizer.setPointerCapture(ev.pointerId);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
}

initTheme();
initDetailResizer();
void currentLayout;

// Re-layout the graph when the viewport changes so the responsive subject
// column (and the sticky header) stay aligned with the date/hash columns.
let resizeTimer: number | undefined;
window.addEventListener('resize', () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(renderCached, 120);
});

/**
 * Build initial tabs. Once the client has persisted tab state, that state is
 * authoritative — a closed repository must stay closed across reloads even though
 * the server still has it registered. Only a truly fresh client (no saved key at
 * all) seeds from the server's default repo (LIANA_REPO / Electron launch).
 */
async function bootstrap(): Promise<void> {
  const initialized = localStorage.getItem(REPOS_KEY) !== null;
  const saved = readSavedRepos();
  // Read before registering tabs: addRepo() persists and would overwrite this.
  const savedActive = localStorage.getItem(ACTIVE_KEY);

  let paths = saved;
  if (!initialized) {
    try {
      const { repos } = await api<{ repos: RepoEntry[] }>('/repos', undefined, { scoped: false });
      paths = repos.map((r) => r.path);
    } catch {
      // Server may still be starting (dev-server restart); start with no tabs.
    }
  }
  for (const path of paths) {
    try {
      await addRepo(path, false);
    } catch {
      // Drop paths that no longer resolve to a repository.
    }
  }
  const target = tabs.find((t) => t.path === savedActive) ?? tabs[0];
  if (target) {
    await activateRepo(target.id);
  } else {
    renderTabs();
    renderNoRepo();
  }

  // Reopen the review tabs that were open before the reload, each bound to its repo.
  let savedReviewPaths = readSavedReviewPaths();
  let savedReviewActive: string | null = null;
  try {
    savedReviewActive = localStorage.getItem(REVIEW_ACTIVE_KEY);
  } catch {
    savedReviewActive = null;
  }
  // Migrate the pre-multi-review key so an existing single review tab survives.
  try {
    const legacy = localStorage.getItem('liana-review-repo');
    if (legacy) {
      if (!savedReviewPaths.includes(legacy)) savedReviewPaths.push(legacy);
      if (!savedReviewActive) savedReviewActive = legacy;
      localStorage.removeItem('liana-review-repo');
    }
  } catch {
    // ignore
  }
  for (const path of savedReviewPaths) {
    const bound = tabs.find((t) => t.path === path);
    if (!bound) continue;
    const state: ReviewTabState = {
      repoId: bound.id,
      repoPath: bound.path,
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
    reviewTabs.set(bound.id, state);
    void loadMergeRequests(state);
    void loadSessionsAndMaybeRestore(state);
  }
  if (savedReviewActive) {
    const bound = tabs.find((t) => t.path === savedReviewActive);
    const state = bound ? reviewTabs.get(bound.id) : undefined;
    if (bound && state) {
      activeReviewId = bound.id;
      // Review is a per-repo view; make its repository active so it stays bound.
      if (activeId !== bound.id) {
        saveActive();
        loadTab(bound);
        void refresh();
      }
      updateReviewVisibility();
      paintReview(state);
    }
  }
  persistReviewTabs();
  renderTabs();
}

void bootstrap();
scheduleActivityPoll();
