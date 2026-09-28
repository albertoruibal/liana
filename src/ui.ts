// UI entry: wires the graph pane, detail pane, toolbar actions, and dialogs.

import { layoutGraph } from './layout';
import { renderGraph } from './graph';
import type { GraphLayout, GitCommit, RepoState, RepoStatus } from './types';

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
  const res = await fetch(`/api${route}`, {
    method: body !== undefined ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
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
  if (!commit) {
    html += '<h3>Repository</h3>';
    if (state) {
      html += `<p class="muted">${esc(repoName)} — ${esc(state.headBranch ?? 'detached HEAD')}</p>`;
      if (state.branches.length > 0) {
        html += '<h4>Branches</h4><ul class="branch-list">';
        for (const b of state.branches) {
          const head = b.isHead ? ' <span class="ref-head">HEAD</span>' : '';
          const remote = b.isRemote ? ' (remote)' : '';
          html += `<li data-branch="${esc(b.name)}">${esc(b.name)}${remote}${head}</li>`;
        }
        html += '</ul>';
        html += '<p class="muted hint">Click a branch to checkout</p>';
      }
    }
    if (status && status.entries.length > 0) {
      html += '<h4>Changes</h4><ul class="status-list">';
      for (const e of status.entries) {
        html += `<li><span class="status-code">${esc(e.code)}</span> ${esc(e.path)}</li>`;
      }
      html += '</ul>';
    } else {
      html += '<p class="muted">Working tree clean</p>';
    }
  } else {
    const short = commit.hash.slice(0, 7);
    html += `<h3>${esc(commit.subject)}</h3>`;
    html += `<p class="muted">${esc(commit.author)} · ${fmtDate(commit.timestamp)} · <code>${short}</code></p>`;
    if (commit.refs.length > 0) {
      html += '<p>' + commit.refs.map((r) => `<span class="ref-chip">${esc(r)}</span>`).join(' ') + '</p>';
    }
    const isHead = commit.refs.includes('HEAD');
    // Tip of the currently checked-out branch
    const headTip = (state?.branches ?? []).find((b) => b.isHead);
    const atBranchTip = headTip !== undefined && headTip.hash === commit.hash;

    html += '<div class="actions">';
    if (!isHead) {
      html += `<button class="act" data-act="cherry-pick">Cherry-pick onto ${esc(state?.headBranch ?? 'HEAD')}</button>`;
    }
    if (!atBranchTip) {
      html += `<button class="act" data-act="rebase-here">Rebase ${esc(state?.headBranch ?? 'branch')} onto this commit</button>`;
    }
    html += '</div>';
    html += '<p class="muted hint">Operations run on the checked-out branch; the graph reloads after.</p>';
  }
  pane.innerHTML = html;

  // wire action buttons
  pane.querySelectorAll<HTMLButtonElement>('button.act').forEach((btn) => {
    btn.addEventListener('click', () => void runAction(btn));
  });
  // wire branch checkout
  pane.querySelectorAll<HTMLLIElement>('li[data-branch]').forEach((li) => {
    li.addEventListener('click', () => void checkout(li.dataset.branch ?? ''));
  });
}

function renderAll(resp: StateResponse): void {
  const commits = resp.commits ?? [];
  const layout = layoutGraph(commits);
  currentLayout = layout;
  renderGraph($svg('#graph-svg'), { name: repoName, ...resp.state } as RepoState, layout);
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
      await api('/cherry-pick', { ref: selectedHash });
    } else if (act === 'rebase-here') {
      await api('/rebase', { onto: selectedHash });
    }
    await refresh();
  } catch (err) {
    alert(`Operation failed:\n${String(err)}`);
  } finally {
    btn.disabled = false;
  }
}

async function checkout(branch: string): Promise<void> {
  if (!branch) return;
  await api('/checkout', { branch });
  selectedHash = null;
  await refresh();
}

// --- Wire up static UI ---

$('#btn-refresh').addEventListener('click', () => void refresh());

$('#btn-commit').addEventListener('click', () => {
  const dlg = $<HTMLDialogElement>('#commit-dialog');
  $('#commit-status').textContent = '';
  dlg.showModal();
});

$('#commit-submit').addEventListener('click', () => {
  const msg = $<HTMLTextAreaElement>('#commit-message').value.trim();
  if (!msg) {
    $('#commit-status').textContent = 'Message required';
    return;
  }
  void (async () => {
    try {
      await api('/commit', { message: msg });
      $<HTMLTextAreaElement>('#commit-message').value = '';
      $<HTMLDialogElement>('#commit-dialog').close();
      await refresh();
    } catch (err) {
      $('#commit-status').textContent = String(err);
    }
  })();
});

$('#btn-open-repo').addEventListener('click', () => {
  const p = prompt('Path to git repository:', repoName ? '' : '~/workspace/my-repo');
  if (!p) return;
  void (async () => {
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
$svg('#graph-svg').addEventListener('click', (ev) => {
  const el = ev.target as SVGElement;
  const hash = el.dataset?.hash;
  if (!hash) return;
  selectedHash = hash;
  void refresh();
});

void currentLayout;
void refresh();