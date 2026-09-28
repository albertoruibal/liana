// UI entry: wires the graph pane, detail pane, toolbar actions, and dialogs.

import { layoutGraph } from './layout';
import { EMPTY_METRICS, avatarColor, initials, renderGraph, type GraphMetrics } from './graph';
import { refIconHtml, refLabel } from './refs';
import { isoDate, isoDateTime } from './dates';
import { INTERACTIVE_REBASE_ENABLED } from './config';
import type { GitCommit, GraphLayout, RebaseAction, RebaseTodoItem, RemoteStatus, RepoState, RepoStatus, ResetMode, StatusEntry } from './types';

interface StateResponse {
  configured: boolean;
  repoPath?: string;
  state?: RepoState;
  commits?: GitCommit[];
  status?: RepoStatus;
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
  applyTransform();
  renderTabs();
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
}

async function api<T>(route: string, body?: unknown, opts: ApiOpts = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = window.liana?.token;
  if (token) headers['x-liana-token'] = token;
  if (opts.scoped !== false && activeId) headers['x-liana-repo'] = activeId;
  const res = await fetch(`/api${route}`, {
    method: body !== undefined ? 'POST' : 'GET',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

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

/** Colourise a `git show --stat` block without trusting its content as HTML. */
function formatDiffStat(stat: string): string {
  return esc(stat)
    .split('\n')
    .map((line) => {
      if (/^\s*\|/.test(line) || /\d+ [+-]/.test(line)) {
        const withAdd = line.replace(/(\+{1,})/g, '<span class="dl-add">$1</span>');
        return withAdd.replace(/(?<!<[^>]*)(-{1,})(?!>)/g, '<span class="dl-del">$1</span>');
      }
      if (/^\s*\d+ files? changed/.test(line)) return `<span class="dl-meta">${line}</span>`;
      return `<span class="dl-file">${line}</span>`;
    })
    .join('\n');
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

function renderDetail(commits: GitCommit[], state: RepoState | undefined, status: RepoStatus | undefined): void {
  const pane = $('#detail-pane');
  const commit = commits.find((c) => c.hash === selectedHash);

  let html = '';
  const dirty = status?.entries.length ?? 0;
  if (dirty > 0) {
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
          html += `<li class="branch-${kind}" data-branch="${esc(b.name)}" title="Checkout ${esc(b.name)}">
            ${refIconHtml(kind)}
            <span class="branch-name">${esc(b.name)}</span>
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
    html += `<div class="detail-empty">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" fill="currentColor"/><path d="M12 2v7M12 15v7M2 12h7M15 12h7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
      <strong>No commit selected</strong>
      <span class="hint">Pick a commit in the graph to see details and actions.</span>
    </div>`;
  } else {
    const short = commit.hash.slice(0, 7);
    html += `<div class="detail-head"><h3>${esc(commit.subject)}</h3>`;
    html += `<div class="meta-row">
      <span class="meta-chip">${avatarHtml(commit.author, true)}${esc(commit.author)}</span>
      <span class="meta-chip" title="${esc(isoDateTime(commit.timestamp))}">${isoDate(commit.timestamp)}</span>
      <span class="meta-chip"><code>${short}</code></span>
    </div>`;
    if (commit.refs.length > 0) {
      html +=
        '<p class="meta-row">' +
        commit.refs
          .map((r) => `<span class="ref-pill ref-${r.kind}" title="${esc(refLabel(r))}">${refIconHtml(r.kind)}${esc(r.name)}</span>`)
          .join(' ') +
        '</p>';
    }
    html += '</div>';
    const isHead = commit.refs.some((r) => r.kind === 'head');
    // Tip of the currently checked-out branch
    const headTip = (state?.branches ?? []).find((b) => b.isHead);
    const atBranchTip = headTip !== undefined && headTip.hash === commit.hash;

    html += '<div class="actions">';
    if (commit.isStash) {
      const branch = commit.stash?.branch ? ` (from ${esc(commit.stash.branch)})` : '';
      html += `<p class="muted hint">Stash entry${branch}. Applying restores the saved changes on the checked-out branch.</p>`;
      html += `<button class="btn act" data-act="stash-apply">Apply stash — keep the entry</button>`;
      html += `<button class="btn act" data-act="stash-pop">Apply stash &amp; drop it</button>`;
      html += `<button class="btn act btn-danger" data-act="stash-drop">Drop stash</button>`;
    } else {
      if (!isHead) {
        if (commit.parents.length >= 2) {
          html += `<p class="muted hint">Merge commit — pick a parent to cherry-pick against:</p>`;
          commit.parents.forEach((p, i) => {
            html += `<button class="btn act" data-act="cherry-pick" data-mainline="${i + 1}">Cherry-pick onto ${esc(state?.headBranch ?? 'HEAD')} (-m ${i + 1}) <code>${esc(p.slice(0, 7))}</code></button>`;
          });
        } else {
          html += `<button class="btn act" data-act="cherry-pick">Cherry-pick onto ${esc(state?.headBranch ?? 'HEAD')}</button>`;
        }
        html += `<label class="checkbox-label"><input type="checkbox" id="cherry-record" /> Record source hash in message (-x)</label>`;
      }
      if (!atBranchTip) {
        html += `<button class="btn act" data-act="rebase-here">Rebase ${esc(state?.headBranch ?? 'branch')} onto this commit</button>`;
        if (INTERACTIVE_REBASE_ENABLED) {
          html += `<button class="btn act" data-act="rebase-interactive">Interactive rebase onto this commit…</button>`;
        }
      }
    }
    html += '</div>';
    html += '<div id="commit-diff" class="diff-stat">Loading diff stats…</div>';
    html += '<div class="detail-empty"><span class="hint">Operations run on the checked-out branch; the graph reloads after.</span></div>';
  }
  pane.innerHTML = html;
  if (commit) void loadDiffStat(commit.hash);

  // wire action buttons
  pane.querySelectorAll<HTMLButtonElement>('button.act').forEach((btn) => {
    btn.addEventListener('click', () => void runAction(btn));
  });
  // wire branch checkout
  pane.querySelectorAll<HTMLLIElement>('li[data-branch]').forEach((li) => {
    li.addEventListener('click', () => void checkout(li.dataset.branch ?? ''));
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
        return `<li><label class="checkbox-label file-row">
          <input type="checkbox" class="commit-file" data-path="${esc(e.path)}" checked />
          <span class="status-badge ${statusClass(e.stagedX === '?' ? '?' : code)}">${esc(code)}</span>
          <span class="status-path" title="${esc(e.path)}">${esc(e.path)}</span>
        </label></li>`;
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
}

async function loadDiffStat(hash: string): Promise<void> {
  try {
    const { stat } = await api<{ stat: string }>('/commit-diff', { hash });
    const el = document.querySelector('#commit-diff');
    if (el && selectedHash === hash) {
      el.innerHTML = stat ? formatDiffStat(stat) : '<span class="dl-meta">(no changes)</span>';
    }
  } catch {
    const el = document.querySelector('#commit-diff');
    if (el && selectedHash === hash) el.textContent = '';
  }
}

/** Lay out the sticky column header to match the SVG's computed column offsets. */
function renderGraphHeader(m: GraphMetrics): void {
  const header = $('#graph-header');
  header.style.width = `${m.totalW}px`;
  const labels: Array<[number, string]> = [
    [m.refX, 'Refs'],
    [m.lanesX - 4, 'Graph'],
    [m.authorX, 'Author'],
    [m.subjectX, 'Commit'],
    [m.dateX, 'Date'],
    [m.hashX, 'Hash'],
  ];
  header.innerHTML = labels
    .map(([x, label]) => `<span style="left:${Math.max(0, Math.round(x))}px">${label}</span>`)
    .join('');
}

function renderAll(resp: StateResponse): void {
  const commits = resp.commits ?? [];
  const layout = layoutGraph(commits);
  currentLayout = layout;
  const metrics = renderGraph($svg('#graph-svg'), { name: repoName, ...resp.state } as RepoState, layout, selectedHash);
  renderGraphHeader(metrics);
  renderDetail(commits, resp.state, resp.status);
  updateSyncButtons();
}

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
  renderGraphHeader(EMPTY_METRICS);
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

/** Switch the active tab, restoring its cached view before refreshing. */
async function activateRepo(id: string): Promise<void> {
  if (id === activeId) return;
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return;
  saveActive();
  loadTab(tab);
  if (tab.lastResponse) renderAll(tab.lastResponse);
  else await refresh();
}

/** Close a tab; adjacent tab becomes active when the closed one was active. */
function closeTab(id: string): void {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const wasActive = id === activeId;
  tabs.splice(idx, 1);
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
  renderTabs();
  persistTabs();
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
    tab.lastResponse = resp;
    tab.remoteStatus = remote;
    lastResponse = resp;
    remoteStatus = remote;
    renderAll(resp);
    renderTabs();
    persistTabs();
  } catch (err) {
    if (activeId !== reqId) return;
    $('#detail-pane').innerHTML = `<p class="error">Failed to load repo: ${esc(String(err))}</p>`;
  }
}

async function runAction(btn: HTMLButtonElement): Promise<void> {
  const act = btn.dataset.act ?? '';
  btn.disabled = true;
  try {
    if (act === 'cherry-pick') {
      const mainline = btn.dataset.mainline ? Number(btn.dataset.mainline) : undefined;
      const record = $<HTMLInputElement>('#cherry-record').checked;
      await api('/cherry-pick', { ref: selectedHash, mainline, record });
    } else if (act === 'rebase-here') {
      await api('/rebase', { onto: selectedHash });
    } else if (act === 'rebase-interactive') {
      await openRebaseDialog();
      return;
    } else if (act === 'stash-apply') {
      await api('/stash-apply', { hash: selectedHash });
    } else if (act === 'stash-pop') {
      await api('/stash-apply', { hash: selectedHash });
      await api('/stash-drop', { hash: selectedHash });
      selectedHash = null;
    } else if (act === 'stash-drop') {
      if (!confirm('Drop this stash entry? The saved changes are discarded.')) return;
      await api('/stash-drop', { hash: selectedHash });
      selectedHash = null;
    }
    await refresh();
  } catch (err) {
    alert(`Operation failed:\n${String(err)}`);
  } finally {
    btn.disabled = false;
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
          <code>${esc(c.hash.slice(0, 7))}</code>
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

async function openRebaseDialog(): Promise<void> {
  const onto = selectedHash;
  if (!onto) return;
  const dlg = $<HTMLDialogElement>('#rebase-dialog');
  $('#rebase-status').textContent = '';
  try {
    const plan = await api<RebaseStartResponse>('/rebase-start', { onto });
    if (plan.items.length === 0) {
      alert('Nothing to rebase: HEAD is already based on this commit.');
      return;
    }
    $('#rebase-summary').textContent = `${plan.items.length} commit(s) to replay onto ${plan.onto.slice(0, 7)} — oldest first`;
    renderRebaseTodo(plan.items);
    dlg.showModal();
  } catch (err) {
    alert(`Cannot start rebase:\n${String(err)}`);
  }
}

async function submitRebase(): Promise<void> {
  const dlg = $<HTMLDialogElement>('#rebase-dialog');
  const onto = selectedHash;
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
    dlg.close();
    await refresh();
  } catch (err) {
    status.textContent = String(err);
  }
}

async function checkout(branch: string): Promise<void> {
  if (!branch) return;
  await api('/checkout', { branch });
  selectedHash = null;
  await refresh();
}

// --- Theme ---

const THEME_KEY = 'liana-theme';

function applyTheme(theme: string): void {
  document.documentElement.dataset.theme = theme;
}

function initTheme(): void {
  applyTheme(localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark');
}

$('#btn-theme').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
});

$('#btn-about').addEventListener('click', () => {
  const tab = activeTab();
  $('#about-version').textContent = __APP_VERSION__;
  const repo = $('#about-repo');
  repo.textContent = tab ? tab.path : 'No repository open';
  repo.title = tab ? tab.path : '';
  $<HTMLDialogElement>('#about-dialog').showModal();
});

// --- Wire up static UI ---

$('#btn-refresh').addEventListener('click', () => void refresh());

$('#btn-stash').addEventListener('click', () => {
  const dlg = $<HTMLDialogElement>('#stash-dialog');
  $('#stash-status').textContent = '';
  $<HTMLInputElement>('#stash-message').value = '';
  $<HTMLInputElement>('#stash-untracked').checked = false;
  dlg.showModal();
});

$('#stash-submit').addEventListener('click', (ev) => {
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

$('#commit-submit').addEventListener('click', (ev) => {
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

$('#rebase-submit').addEventListener('click', (ev) => {
  ev.preventDefault();
  void submitRebase();
});

$('#rebase-cancel').addEventListener('click', (ev) => {
  ev.preventDefault();
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

/** Run a network git action, surfacing git's error and reloading on success. */
async function runSync(route: '/push' | '/pull', body: unknown): Promise<void> {
  try {
    await api(route, body);
    await refresh();
  } catch (err) {
    alert(`${route === '/push' ? 'Push' : 'Pull'} failed:\n${String(err)}`);
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
  try {
    await api('/push', { remote, force });
    await refresh();
  } catch (err) {
    const message = String(err);
    if (!force && /non-fast-forward|\[rejected\]|fetch first/i.test(message)) {
      const branch = rs.currentBranch ?? 'this branch';
      if (confirm(`Push rejected: the remote has commits you don't have.\n\nForce-push ${branch} with --force-with-lease?`)) {
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

function renderLoginDialog(): void {
  const rs = remoteStatus;
  const select = $<HTMLSelectElement>('#login-remote');
  select.replaceChildren();
  const urlLine = $('#login-remote-url');
  const helperLine = $('#login-helper');
  $('#login-status').textContent = '';
  if (!rs || rs.remotes.length === 0) {
    const opt = document.createElement('option');
    opt.textContent = 'No remote configured';
    opt.value = '';
    select.appendChild(opt);
    select.disabled = true;
    urlLine.textContent = '';
    $<HTMLButtonElement>('#login-test').disabled = true;
  } else {
    select.disabled = false;
    $<HTMLButtonElement>('#login-test').disabled = false;
    for (const r of rs.remotes) {
      const opt = document.createElement('option');
      opt.value = r.name;
      opt.textContent = r.name;
      select.appendChild(opt);
    }
    urlLine.textContent = rs.remotes[0]?.url ?? '';
  }
  helperLine.textContent = rs?.credentialHelper
    ? rs.credentialHelper
    : 'none — git will use the SSH agent or prompt-free helpers only';
}

$('#btn-push').addEventListener('click', (ev) => void doPush(ev.shiftKey));
$('#btn-pull').addEventListener('click', () => void doPull());

$('#btn-login').addEventListener('click', () => {
  renderLoginDialog();
  $<HTMLDialogElement>('#login-dialog').showModal();
});

$('#login-remote').addEventListener('change', (ev) => {
  const name = (ev.target as HTMLSelectElement).value;
  const r = (remoteStatus?.remotes ?? []).find((x) => x.name === name);
  $('#login-remote-url').textContent = r?.url ?? '';
  $('#login-status').textContent = '';
});

$('#login-test').addEventListener('click', (ev) => {
  ev.preventDefault();
  const remote = $<HTMLSelectElement>('#login-remote').value;
  if (!remote) return;
  const status = $('#login-status');
  status.textContent = 'Testing…';
  void (async () => {
    try {
      await api('/remote-test', { remote });
      status.textContent = `Connected to ${remote}.`;
    } catch (err) {
      status.textContent = String(err);
    }
  })();
});

$('#login-close').addEventListener('click', (ev) => {
  ev.preventDefault();
  $<HTMLDialogElement>('#login-dialog').close();
});

// Selection: click a dot/label — any SVG element tagged with data-hash.
// Clicking empty SVG space clears the selection.
const graphScroll = $('#graph-scroll');

$svg('#graph-svg').addEventListener('click', (ev) => {
  const el = ev.target as SVGElement;
  const hash = el.dataset?.hash ?? null;
  if (hash === selectedHash) return;
  selectedHash = hash;
  void refresh();
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

function menuTitle(target: ContextTarget): string {
  if (target.kind === 'empty') return 'Repository';
  if (target.kind === 'stash') return `Stash ${target.name ?? ''}`;
  if (target.hash && (lastResponse?.commits ?? []).some((c) => c.hash === target.hash && c.isStash)) {
    return `Stash ${target.hash.slice(0, 7)}`;
  }
  if (target.kind === 'commit' || target.hash === null) return `Commit ${target.hash?.slice(0, 7) ?? ''}`;
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
  if (target.kind === 'local' && name && name !== currentBranch && !target.isHead) {
    items.push({ separator: true });
    items.push({ label: `Checkout ${name}`, action: () => void checkout(name) });
    items.push({ label: `Delete branch ${name}`, danger: true, action: () => void deleteBranch(name, false) });
  } else if (target.kind === 'remote' && name) {
    items.push({ separator: true });
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
    `Reset the checked-out branch to <code>${esc(hash.slice(0, 7))}</code> with <b>--${mode}</b>.`;
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
  $('#name-subtitle').textContent = `At commit ${ref.slice(0, 7)}`;
  $('#name-error').textContent = '';
  const input = $<HTMLInputElement>('#name-input');
  input.value = '';
  $<HTMLButtonElement>('#name-submit').textContent = mode === 'branch' ? 'Create & checkout' : 'Create tag';
  $<HTMLDialogElement>('#name-dialog').showModal();
  input.focus();
}

$('#name-submit').addEventListener('click', (ev) => {
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

// Escape closes an open dialog, otherwise clears the selection.
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  if (!contextMenu.hidden) {
    closeContextMenu();
    return;
  }
  const commitDlg = $<HTMLDialogElement>('#commit-dialog');
  const rebaseDlg = $<HTMLDialogElement>('#rebase-dialog');
  const nameDlg = $<HTMLDialogElement>('#name-dialog');
  const resetDlg = $<HTMLDialogElement>('#reset-dialog');
  const stashDlg = $<HTMLDialogElement>('#stash-dialog');
  const loginDlg = $<HTMLDialogElement>('#login-dialog');
  const aboutDlg = $<HTMLDialogElement>('#about-dialog');
  if (aboutDlg.open) {
    aboutDlg.close();
    return;
  }
  if (loginDlg.open) {
    loginDlg.close();
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
  void refresh();
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
  resizeTimer = window.setTimeout(() => {
    if (lastResponse) renderAll(lastResponse);
  }, 120);
});

/** Build initial tabs from saved paths plus any server-side default (LIANA_REPO). */
async function bootstrap(): Promise<void> {
  const saved = readSavedRepos();
  // Read before registering tabs: addRepo() persists and would clear a stale key.
  const savedActive = localStorage.getItem(ACTIVE_KEY);
  let serverRepos: RepoEntry[] = [];
  try {
    serverRepos = (await api<{ repos: RepoEntry[] }>('/repos', undefined, { scoped: false })).repos;
  } catch {
    // Server may still be starting (dev-server restart); fall back to saved paths.
  }
  const ordered: string[] = [];
  for (const p of [...serverRepos.map((r) => r.path), ...saved]) {
    if (!ordered.includes(p)) ordered.push(p);
  }
  for (const path of ordered) {
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
}

void bootstrap();
