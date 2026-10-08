// Detail pane: operation banner, conflicts, submodules, branch list, and commit files.

import { api } from './api-client';
import { avatarHtml, esc, fileStatHtml, statusClass, syncSummaryHtml } from './format';
import { $ } from './dom';
import { store } from './store';
import { isoDateTime } from '../dates';
import { displayRefs, refIconHtml, remoteBranchName } from '../refs';
import { CommitFile, ConflictEntry, ConflictType, GitCommit, MergeOperation, RepoState, RepoStatus, StatusEntry, SubmoduleInfo, WorktreeInfo } from '../types';
import { runAction } from './actions';
import { checkout } from './rebase';

/** Human label for an operation kind, used in the conflict banner. */
export function operationLabel(kind: MergeOperation['kind']): string {
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
export function conflictTypeLabel(type: ConflictType): string {
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
export function operationBanner(op: MergeOperation): string {
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
export function renderConflicts(conflicts: ConflictEntry[]): string {
  if (conflicts.length === 0) return '';
  const op = store.lastResponse?.operation;
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
export function submoduleStateLabel(s: SubmoduleInfo['status']): string {
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
export function renderSubmodules(submodules: SubmoduleInfo[]): string {
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

/** Badges describing a worktree's state (main / current / locked / prunable). */
function worktreeBadges(w: WorktreeInfo): string {
  const badges: string[] = [];
  if (w.isMain) badges.push('<span class="sub-badge sub-info">main</span>');
  if (w.isCurrent) badges.push('<span class="sub-badge sub-info">current</span>');
  if (w.locked) {
    const title = w.lockReason ? ` title="${esc(w.lockReason)}"` : '';
    badges.push(`<span class="sub-badge sub-warn"${title}>locked</span>`);
  }
  if (w.prunable) {
    const title = w.prunableReason ? ` title="${esc(w.prunableReason)}"` : '';
    badges.push(`<span class="sub-badge sub-conflict"${title}>prunable</span>`);
  }
  return badges.join('');
}

/**
 * Worktree panel: each linked working tree with its branch and the local
 * management actions. The main/current worktrees can't be removed from here,
 * and the current one is already open so it isn't offered.
 */
export function renderWorktrees(worktrees: WorktreeInfo[]): string {
  if (worktrees.length === 0) return '';
  let html = '<h4>Worktrees</h4><ul class="worktree-list">';
  for (const w of worktrees) {
    const branch = w.bare ? '(bare)' : w.detached ? '(detached HEAD)' : w.branch ?? '(unknown)';
    const short = w.head?.slice(0, 8) ?? '';
    const removable = !w.isMain && !w.isCurrent;
    html += `<li class="worktree-item" data-path="${esc(w.path)}">
      <div class="worktree-row">
        ${worktreeBadges(w)}
        <span class="worktree-path" title="${esc(w.path)}">${esc(w.path)}</span>
        ${short ? `<code class="sub-hash">${esc(short)}</code>` : ''}
      </div>
      <div class="worktree-row"><span class="worktree-branch">${esc(branch)}</span></div>
      <div class="worktree-actions">
        ${w.isCurrent || w.prunable || w.bare ? '' : `<button type="button" class="btn btn-sm act" data-act="wt-open" data-path="${esc(w.path)}">Open</button>`}
        <button type="button" class="btn btn-sm act" data-act="wt-move" data-path="${esc(w.path)}">Move</button>
        ${w.locked
          ? `<button type="button" class="btn btn-sm act" data-act="wt-unlock" data-path="${esc(w.path)}">Unlock</button>`
          : `<button type="button" class="btn btn-sm act" data-act="wt-lock" data-path="${esc(w.path)}">Lock</button>`}
        ${removable ? `<button type="button" class="btn btn-sm act btn-danger" data-act="wt-remove" data-path="${esc(w.path)}">Remove</button>` : ''}
      </div>
    </li>`;
  }
  html += '</ul>';
  const anyPrunable = worktrees.some((w) => w.prunable);
  if (anyPrunable) {
    html +=
      '<div class="worktree-actions"><button type="button" class="btn btn-sm act" data-act="wt-prune">Prune stale worktrees</button></div>';
  }
  html +=
    '<p class="muted hint">A worktree is a linked working directory sharing this repository. Open one to give it its own tab; Remove deletes the directory (uncommitted changes block it — commit or stash first).</p>';
  return html;
}

export function renderDetail(commits: GitCommit[], state: RepoState | undefined, status: RepoStatus | undefined): void {
  const pane = $('#detail-pane');
  const commit = commits.find((c) => c.hash === store.selectedHash);

  let html = '';
  const operation = store.lastResponse?.operation;
  const conflicts = store.lastResponse?.conflicts ?? [];
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
      html += `<p class="muted">${esc(store.repoName)} — ${esc(state.headBranch ?? 'detached HEAD')}</p>`;
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
    html += renderSubmodules(store.lastResponse?.submodules ?? []);
    html += renderWorktrees(store.lastResponse?.worktrees ?? []);
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
export function renderCommitFiles(entries: StatusEntry[]): void {
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
export function updateCommitSelection(): void {
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
export async function loadCommitFiles(hash: string): Promise<void> {
  const el = document.querySelector('#commit-diff');
  try {
    const { files } = await api<{ files: CommitFile[] }>('/commit-diff', { hash });
    if (!el || store.selectedHash !== hash) return;
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
    if (el && store.selectedHash === hash) el.textContent = '';
  }
}
