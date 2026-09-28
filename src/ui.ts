// UI entry: wires the graph pane, detail pane, toolbar actions, and dialogs.

import { layoutGraph } from './layout';
import { renderGraph } from './graph';
import { refLabel } from './refs';
import { INTERACTIVE_REBASE_ENABLED } from './config';
import type { GitCommit, GraphLayout, RebaseAction, RebaseTodoItem, RepoState, RepoStatus } from './types';

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

function renderDetail(commits: GitCommit[], state: RepoState | undefined, status: RepoStatus | undefined): void {
  const pane = $('#detail-pane');
  const commit = commits.find((c) => c.hash === selectedHash);

  let html = '';
  const dirty = status?.entries.length ?? 0;
  if (dirty > 0) {
    const noun = dirty === 1 ? 'change' : 'changes';
    html += `<div class="dirty-banner">${dirty} uncommitted ${noun} — commit or stash before rebasing</div>`;
  }
  if (!commit) {
    html += '<h3>Repository</h3>';
    if (state) {
      html += `<p class="muted">${esc(repoName)} — ${esc(state.headBranch ?? 'detached HEAD')}</p>`;
      if (state.branches.length > 0) {
        html += '<h4>Branches</h4><ul class="branch-list">';
        for (const b of state.branches) {
          const head = b.isHead ? ' <span class="ref-head">HEAD</span>' : '';
          const kind = b.isRemote
            ? '<span class="ref-kind ref-remote">remote</span>'
            : '<span class="ref-kind ref-local">local</span>';
          html += `<li data-branch="${esc(b.name)}">${kind}${esc(b.name)}${head}</li>`;
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
          html += `<li><span class="status-code">${esc(e.stagedX)}</span> ${esc(e.path)}</li>`;
        }
        html += '</ul>';
      }
      if (unstaged.length > 0) {
        html += '<h4>Unstaged</h4><ul class="status-list">';
        for (const e of unstaged) {
          const code = e.stagedX === '?' ? '??' : e.unstagedY;
          html += `<li><span class="status-code">${esc(code)}</span> ${esc(e.path)}</li>`;
        }
        html += '</ul>';
      }
    } else {
      html += '<p class="muted">Working tree clean</p>';
    }
  } else {
    const short = commit.hash.slice(0, 7);
    html += `<h3>${esc(commit.subject)}</h3>`;
    html += `<p class="muted">${esc(commit.author)} · ${fmtDate(commit.timestamp)} · <code>${short}</code></p>`;
    if (commit.refs.length > 0) {
      html +=
        '<p>' +
        commit.refs
          .map((r) => `<span class="ref-chip ref-${r.kind}">${esc(refLabel(r))}</span>`)
          .join(' ') +
        '</p>';
    }
    const isHead = commit.refs.some((r) => r.kind === 'head');
    // Tip of the currently checked-out branch
    const headTip = (state?.branches ?? []).find((b) => b.isHead);
    const atBranchTip = headTip !== undefined && headTip.hash === commit.hash;

    html += '<div class="actions">';
    if (!isHead) {
      if (commit.parents.length >= 2) {
        html += `<p class="muted hint">Merge commit — pick a parent to cherry-pick against:</p>`;
        commit.parents.forEach((p, i) => {
          html += `<button class="act" data-act="cherry-pick" data-mainline="${i + 1}">Cherry-pick onto ${esc(state?.headBranch ?? 'HEAD')} (-m ${i + 1}) <code>${esc(p.slice(0, 7))}</code></button>`;
        });
      } else {
        html += `<button class="act" data-act="cherry-pick">Cherry-pick onto ${esc(state?.headBranch ?? 'HEAD')}</button>`;
      }
      html += `<label class="checkbox-label"><input type="checkbox" id="cherry-record" /> Record source hash in message (-x)</label>`;
    }
    if (!atBranchTip) {
      html += `<button class="act" data-act="rebase-here">Rebase ${esc(state?.headBranch ?? 'branch')} onto this commit</button>`;
      if (INTERACTIVE_REBASE_ENABLED) {
        html += `<button class="act" data-act="rebase-interactive">Interactive rebase onto this commit…</button>`;
      }
    }
    html += '</div>';
    html += '<div id="commit-diff" class="diff-stat">Loading diff stats…</div>';
    html += '<p class="muted hint">Operations run on the checked-out branch; the graph reloads after.</p>';
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
    if (el && selectedHash === hash) el.textContent = stat || '(no changes)';
  } catch {
    const el = document.querySelector('#commit-diff');
    if (el && selectedHash === hash) el.textContent = '';
  }
}

function renderAll(resp: StateResponse): void {
  const commits = resp.commits ?? [];
  const layout = layoutGraph(commits);
  currentLayout = layout;
  renderGraph($svg('#graph-svg'), { name: repoName, ...resp.state } as RepoState, layout, selectedHash);
  renderDetail(commits, resp.state, resp.status);
}

// --- Actions ---

async function refresh(): Promise<void> {
  try {
    const resp = await api<StateResponse>('/state');
    if (!resp.configured) {
      $('#repo-name').textContent = 'no repo open — use "Open repo…"';
      $('#detail-pane').innerHTML =
        '<h3>liana</h3><p class="muted">Click "Open repo…" and pick a git repository folder.</p>';
      return;
    }
    repoName = resp.state?.name ?? '';
    $('#repo-name').textContent = repoName;
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
        `<li data-hash="${esc(c.hash)}">
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

// Escape closes an open dialog, otherwise clears the selection.
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  const commitDlg = $<HTMLDialogElement>('#commit-dialog');
  const rebaseDlg = $<HTMLDialogElement>('#rebase-dialog');
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
void refresh();
