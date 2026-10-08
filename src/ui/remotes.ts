// Push / pull / remotes: sync buttons, progress dialog, remote picker, branch pills.

import { api } from './api-client';
import { esc } from './format';
import { activeTab, store } from './store';
import { toast } from './toast';
import { $ } from './dom';
import { confirmDialog } from './confirm';
import { refresh } from './actions';
import { checkout } from './rebase';
import { $svg } from './dom';
import { applyTransform, renderCached } from './graph-view';

// --- Push / pull / remotes ---
/** Enable the sync buttons and set an informative tooltip from the remote status. */
export function updateSyncButtons(): void {
  const hasRepo = !!activeTab();
  const rs = store.remoteStatus;
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
export function openSyncDialog(title: string, detail: string): void {
  const dlg = $<HTMLDialogElement>('#sync-dialog');
  $('#sync-title').textContent = title;
  $('#sync-detail').textContent = detail;
  if (!dlg.open) dlg.showModal();
}

export function closeSyncDialog(): void {
  const dlg = $<HTMLDialogElement>('#sync-dialog');
  if (dlg.open) dlg.close();
}

/** Run a network git action, surfacing git's error and reloading on success. */
export async function runSync(route: '/push' | '/pull', body: unknown): Promise<void> {
  const rs = store.remoteStatus;
  if (route === '/pull') {
    const detail = rs?.upstream ? `${rs.upstream} into ${rs.currentBranch ?? 'HEAD'}` : '';
    openSyncDialog('Pulling…', detail);
  }
  try {
    await api(route, body);
    await refresh();
  } catch (err) {
    toast(`${route === '/push' ? 'Push' : 'Pull'} failed: ${String(err)}`);
  } finally {
    closeSyncDialog();
  }
}

/**
 * Push, prompting for a remote when several exist and none is the upstream.
 * `force` adds `--force-with-lease` (shift-click, or accepting the offer after a
 * rejected non-fast-forward push).
 */
export async function doPush(force = false): Promise<void> {
  const rs = store.remoteStatus;
  if (!rs) return;
  if (rs.remotes.length === 0) {
    toast('No remote configured. Add one with `git remote add <name> <url>`.', 'info');
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
      if (
        await confirmDialog({
          title: 'Push rejected',
          message: `The remote has commits you don't have. Force-push ${branchName} with --force-with-lease?`,
          confirmLabel: 'Force-push',
          danger: true,
        })
      ) {
        await doPush(true);
      }
      return;
    }
    toast(`Push failed: ${message}`);
  }
}

export async function doPull(): Promise<void> {
  const rs = store.remoteStatus;
  if (!rs) return;
  if (!rs.upstream) {
    toast('No upstream configured. Push this branch first to set one.', 'info');
    return;
  }
  await runSync('/pull', {});
}

/** Modal remote chooser; resolves to the chosen name or null when cancelled. */
export function pickRemote(subtitle: string): Promise<string | null> {
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
    for (const r of store.remoteStatus?.remotes ?? []) {
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

// Selection: click a dot/label — any SVG element tagged with data-hash.
// Clicking empty SVG space clears the selection.
export const graphScroll = $('#graph-scroll');

/** The branch pill under a graph click, if any. Only local and remote branch
 * pills act on a double click; head/tag/stash chips and the "+N" badge don't. */
export function branchPillTarget(ev: Event): { kind: 'local' | 'remote'; name: string } | null {
  const node = (ev.target as Element).closest('[data-kind], [data-name]') as SVGElement | null;
  const kind = node?.dataset.kind;
  const name = node?.dataset.name ?? '';
  if (!name || (kind !== 'local' && kind !== 'remote')) return null;
  return { kind, name };
}

/** Act on the branch behind a pill. A local branch is checked out (a no-op when
 * it is already current); a remote branch resets the checked-out branch to the
 * remote tip, after confirming, since that discards working-tree changes. */
export async function checkoutBranchPill(pill: { kind: 'local' | 'remote'; name: string }): Promise<void> {
  const state = store.lastResponse?.state;
  const currentBranch = state?.headBranch ?? '';
  if (pill.kind === 'local') {
    if (pill.name === currentBranch) return;
    await checkout(pill.name);
    return;
  }
  if (!currentBranch || state?.detachedHead) {
    toast('Cannot reset: HEAD is detached');
    return;
  }
  const ok = await confirmDialog({
    title: 'Reset current branch?',
    message: `Move ${currentBranch} to ${pill.name} with --hard, discarding the current working tree.`,
    confirmLabel: 'Reset --hard',
    danger: true,
    warning: 'Uncommitted changes will be discarded.',
  });
  if (!ok) return;
  try {
    await api('/reset', { mode: 'hard', ref: pill.name });
    store.selectedHash = null;
    await refresh();
  } catch (err) {
    toast(`Reset failed: ${String(err)}`);
  }
}

// A double click on a branch pill checks it out. The browser never delivers the
// native dblclick over a pill: the first click's renderCached() rebuilds the
// whole SVG, so the two clicks of the gesture land on different elements and
// dblclick is only dispatched when both clicks share a target. Recognize the
// pair manually instead — same pill, within the usual double-click window.
export const DBL_CLICK_MS = 500;

export let lastPillClick: { key: string; at: number } | null = null;

export function initRemotes(): void {
  // The git process keeps running regardless, so Escape must not dismiss the
  // progress dialog and leave the user without feedback.
  $('#sync-dialog').addEventListener('cancel', (ev) => ev.preventDefault());

  $('#btn-push').addEventListener('click', (ev) => void doPush(ev.shiftKey));

  $('#btn-pull').addEventListener('click', () => void doPull());

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
      void checkoutBranchPill(pill);
      return;
    }
    // Clicking the selected row again clears the selection.
    store.selectedHash = hash === store.selectedHash ? null : hash;
    renderCached();
  });

  // Ctrl+wheel zooms about the cursor; plain wheel keeps scrolling the pane.
  graphScroll.addEventListener(
    'wheel',
    (ev) => {
      if (!ev.ctrlKey) return;
      ev.preventDefault();
      const prev = store.zoom;
      const next = Math.min(3, Math.max(0.3, prev * (ev.deltaY < 0 ? 1.1 : 0.9)));
      if (next === prev) return;
      // Keep the point under the cursor fixed while scaling.
      const rect = graphScroll.getBoundingClientRect();
      const cx = ev.clientX - rect.left + graphScroll.scrollLeft;
      const cy = ev.clientY - rect.top + graphScroll.scrollTop;
      store.panX = cx - ((cx - store.panX) * next) / prev;
      store.panY = cy - ((cy - store.panY) * next) / prev;
      store.zoom = next;
      applyTransform();
    },
    { passive: false },
  );
}
