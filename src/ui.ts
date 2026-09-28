// UI entry: wires the graph pane, detail pane, toolbar actions, and dialogs.

import { layoutGraph } from './layout';
import { EMPTY_METRICS, avatarColor, initials, renderGraph, type GraphMetrics } from './graph';
import { refLabel } from './refs';
import { INTERACTIVE_REBASE_ENABLED } from './config';
import type { GitCommit, GraphLayout, RebaseAction, RebaseTodoItem, RepoState, RepoStatus, ResetMode } from './types';

interface StateResponse {
  configured: boolean;
  repoPath?: string;
  state?: RepoState;
  commits?: GitCommit[];
  status?: RepoStatus;
}

let currentLayout: GraphLayout | null = null;
let selectedHash: string | null = null;
let repoName = '';
let lastResponse: StateResponse | null = null;

// Graph viewport transform: pan offset (px) and zoom scale.
let panX = 0;
let panY = 0;
let zoom = 1;

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

async function api<T>(route: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = window.liana?.token;
  if (token) headers['x-liana-token'] = token;
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

function fmtDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
      if (state.branches.length > 0) {
        html += '<h4>Branches</h4><ul class="branch-list">';
        for (const b of state.branches) {
          const color = avatarColor(b.name);
          const badge = b.isHead ? '<span class="head-badge">HEAD</span>' : '';
          html += `<li data-branch="${esc(b.name)}" title="Checkout ${esc(b.name)}">
            <span class="branch-dot" style="background:${color}"></span>
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
      <span class="meta-chip">${fmtDate(commit.timestamp)}</span>
      <span class="meta-chip"><code>${short}</code></span>
    </div>`;
    if (commit.refs.length > 0) {
      html +=
        '<p class="meta-row">' +
        commit.refs
          .map((r) => `<span class="ref-pill ref-${r.kind}">${esc(refLabel(r))}</span>`)
          .join(' ') +
        '</p>';
    }
    html += '</div>';
    const isHead = commit.refs.some((r) => r.kind === 'head');
    // Tip of the currently checked-out branch
    const headTip = (state?.branches ?? []).find((b) => b.isHead);
    const atBranchTip = headTip !== undefined && headTip.hash === commit.hash;

    html += '<div class="actions">';
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
  setRepoDirty(resp.status?.entries.length ?? 0);
}

function setRepoDirty(count: number): void {
  const dot = $('#repo-dirty-dot');
  dot.hidden = count === 0;
  dot.title = `${count} uncommitted ${count === 1 ? 'change' : 'changes'}`;
}

function setRepoName(name: string): void {
  const el = $('#repo-name');
  el.textContent = name;
  el.classList.toggle('is-empty', name.length === 0);
}

// --- Actions ---

async function refresh(): Promise<void> {
  try {
    const resp = await api<StateResponse>('/state');
    if (!resp.configured) {
      setRepoName('no repo open');
      renderGraphHeader(EMPTY_METRICS);
      $('#detail-pane').innerHTML =
        `<div class="detail-empty">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm11 13.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0ZM4.5 5v6.75c0 .4.1.6.35.85l3.3 3.3c.5.5 1.35.5 1.85 0l.6-.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
          <strong>liana</strong>
          <span class="hint">Open a local git repository to see its commit graph.</span>
        </div>`;
      return;
    }
    repoName = resp.state?.name ?? '';
    setRepoName(repoName);
    lastResponse = resp;
    renderAll(resp);
  } catch (err) {
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

// --- Wire up static UI ---

$('#btn-refresh').addEventListener('click', () => void refresh());

$('#btn-commit').addEventListener('click', () => {
  const dlg = $<HTMLDialogElement>('#commit-dialog');
  $('#commit-status').textContent = '';
  dlg.showModal();
});

$('#commit-submit').addEventListener('click', (ev) => {
  // Keep the dialog open until the commit succeeds so errors stay visible.
  ev.preventDefault();
  const msg = $<HTMLTextAreaElement>('#commit-message').value.trim();
  if (!msg) {
    $('#commit-status').textContent = 'Message required';
    return;
  }
  const stageAll = $<HTMLInputElement>('#commit-stage-all').checked;
  void (async () => {
    try {
      await api('/commit', { message: msg, stageAll });
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

$('#btn-open-repo').addEventListener('click', () => {
  void (async () => {
    // Electron has no window.prompt — use the native folder picker when available.
    const p = window.liana
      ? await window.liana.openRepoDialog()
      : prompt('Path to git repository:', repoName ? '' : '~/workspace/my-repo');
    if (!p) return;
    try {
      await api('/open', { path: p });
      selectedHash = null;
      await refresh();
    } catch (err) {
      alert(String(err));
    }
  })();
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
  kind: 'commit' | 'local' | 'remote' | 'tag' | 'empty';
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
    return { kind: kind as 'local' | 'remote' | 'tag', hash, name };
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
  if (resetDlg.open) {
    resetDlg.close();
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

void refresh();
