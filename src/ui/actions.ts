// Toolbar/refresh actions: reload repo state and dispatch detail-pane actions.

import { api } from './api-client';
import { copyToClipboard } from './clipboard';
import { esc } from './format';
import { renderAll } from './graph-view';
import { updateReviewVisibility } from './review-view';
import { StateResponse, activeTab } from './store';
import { addRepo, persistTabs, renderNoRepo, renderTabs } from './tabs';
import { toast } from './toast';
import { $ } from './dom';
import { store } from './store';
import { RemoteStatus } from '../types';
import { openAiConflictDialog } from './ai-conflict';
import { openConflictDialog, openSubmoduleHistory } from './conflicts';
import { promptText } from './worktree';
import { refreshActivity } from './status-bar';
export async function refresh(): Promise<void> {
  const reqId = store.activeId;
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
    if (store.activeId !== reqId) return;
    store.repoName = resp.state?.name ?? tab.name;
    tab.name = store.repoName;
    if (store.activeReviewId === tab.id) updateReviewVisibility();
    tab.lastResponse = resp;
    tab.remoteStatus = remote;
    store.lastResponse = resp;
    store.remoteStatus = remote;
    // While a review tab is shown the graph columns are hidden, so skip
    // drawing; closing the review tab re-renders from the cached response.
    if (store.activeReviewId === null) renderAll(resp);
    renderTabs();
    persistTabs();
    void refreshActivity();
  } catch (err) {
    if (store.activeId !== reqId) return;
    $('#detail-pane').innerHTML = `<p class="error">Failed to load repo: ${esc(String(err))}</p>`;
  }
}

export async function runAction(btn: HTMLButtonElement): Promise<void> {
  const act = btn.dataset.act ?? '';
  const path = btn.dataset.path ?? '';
  btn.disabled = true;
  try {
    if (act === 'stash-apply') {
      await api('/stash-apply', { hash: store.selectedHash });
    } else if (act === 'stash-pop') {
      await api('/stash-apply', { hash: store.selectedHash });
      await api('/stash-drop', { hash: store.selectedHash });
      store.selectedHash = null;
    } else if (act === 'stash-drop') {
      if (!confirm('Drop this stash entry? The saved changes are discarded.')) return;
      await api('/stash-drop', { hash: store.selectedHash });
      store.selectedHash = null;
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
    } else if (act === 'wt-open') {
      await addRepo(path, true);
      return;
    } else if (act === 'wt-remove') {
      if (!confirm(`Remove worktree ${path}? Its working directory is deleted. Uncommitted changes will block this.`)) return;
      try {
        await api('/worktree-remove', { path });
      } catch (err) {
        if (confirm(`${String(err)}\n\nForce removal? Uncommitted changes in that worktree are discarded.`)) {
          await api('/worktree-remove', { path, force: true });
        } else {
          return;
        }
      }
    } else if (act === 'wt-lock') {
      const reason = await promptText(`Lock ${path}`, 'Reason (optional):');
      if (reason === null) return;
      await api('/worktree-lock', { path, reason });
    } else if (act === 'wt-unlock') {
      await api('/worktree-unlock', { path });
    } else if (act === 'wt-move') {
      const to = await promptText(`Move ${path}`, 'New directory:', path);
      if (to === null || !to.trim() || to.trim() === path) return;
      await api('/worktree-move', { path, to: to.trim() });
    } else if (act === 'wt-prune') {
      await api('/worktree-prune', {});
    } else if (act === 'copy-subject' || act === 'copy-hash') {
      await copyToClipboard(btn.dataset.copy ?? '');
      return;
    }
    await refresh();
  } catch (err) {
    toast(`Operation failed: ${String(err)}`);
  } finally {
    if (btn.isConnected) btn.disabled = false;
  }
}

export function initActions(): void {
  $('#btn-refresh').addEventListener('click', () => void refresh());
}
