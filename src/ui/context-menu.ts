// Right-click context menus (graph, detail pane): branch/tag/stash/reset/cherry-pick/revert actions.

import { api } from './api-client';
import { copyToClipboard } from './clipboard';
import { esc } from './format';
import { openNameDialog } from './name-dialog';
import { remoteLocalName } from './rebase';
import { store } from './store';
import { toast } from './toast';
import { $ } from './dom';
import { INTERACTIVE_REBASE_ENABLED } from '../config';
import { ResetMode } from '../types';
import { refresh } from './actions';
import { checkout, openRebaseDialog } from './rebase';
import { openWorktreeDialog } from './worktree';
import { openCodeViewer } from './code-viewer';
import { openSubprojectDialog } from './conflicts';
import { openDiffDialog } from './diff-view';
import { $svg } from './dom';
import { graphScroll } from './remotes';

// --- Right-click context menu: create branch/tag, delete branch/tag ---
export interface ContextTarget {
  kind: 'commit' | 'local' | 'remote' | 'tag' | 'stash' | 'empty';
  hash: string | null;
  name?: string;
  isHead?: boolean;
}

export const contextMenu = $('#context-menu');

export function closeContextMenu(): void {
  contextMenu.hidden = true;
}

export function menuTitle(target: ContextTarget): string {
  if (target.kind === 'empty') return 'Repository';
  if (target.kind === 'stash') return `Stash ${target.name ?? ''}`;
  if (target.hash && (store.lastResponse?.commits ?? []).some((c) => c.hash === target.hash && c.isStash)) {
    return `Stash ${target.hash.slice(0, 8)}`;
  }
  if (target.kind === 'commit' || target.hash === null) return `Commit ${target.hash?.slice(0, 8) ?? ''}`;
  return `${target.kind} ${target.name ?? ''}`;
}

export interface MenuItem {
  label?: string;
  action?: () => void;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
}

export function buildMenu(target: ContextTarget): MenuItem[] {
  const items: MenuItem[] = [];
  const hash = target.hash;
  const isStash =
    target.kind === 'stash' ||
    (hash !== null && (store.lastResponse?.commits ?? []).some((c) => c.hash === hash && c.isStash));
  if (isStash && hash) {
    items.push({ label: 'Apply stash — keep the entry', action: () => void applyStash(hash) });
    items.push({ label: 'Apply stash & drop it', action: () => void popStash(hash) });
    items.push({ label: 'Drop stash', danger: true, action: () => void dropStash(hash) });
    return items;
  }
  if (hash) {
    items.push({ label: 'Create branch here…', action: () => openNameDialog('branch', hash) });
    items.push({ label: 'Create tag here…', action: () => openNameDialog('tag', hash) });
    items.push({ label: 'Create worktree here…', action: () => openWorktreeDialog(hash) });
  }
  const name = target.name ?? '';
  const currentBranch = store.lastResponse?.state?.headBranch ?? '';
  const detached = store.lastResponse?.state?.detachedHead ?? false;
  const commit = hash ? (store.lastResponse?.commits ?? []).find((c) => c.hash === hash) : undefined;
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
    items.push({ label: `Create worktree from ${name}…`, action: () => openWorktreeDialog(name) });
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

export function showContextMenu(target: ContextTarget, x: number, y: number): void {
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

export function targetFromSvg(el: Element | null): ContextTarget {
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

export async function rebaseOntoBranch(name: string): Promise<void> {
  const branch = store.lastResponse?.state?.headBranch ?? 'the current branch';
  if (!confirm(`Rebase ${branch} onto ${name}?`)) return;
  try {
    await api('/rebase', { onto: name });
    await refresh();
  } catch (err) {
    toast(`Rebase failed: ${String(err)}`);
  }
}

export async function cherryPickFromMenu(hash: string, mainline?: number, record?: boolean): Promise<void> {
  const branch = store.lastResponse?.state?.headBranch ?? 'the current branch';
  const what = mainline !== undefined ? `commit ${hash.slice(0, 8)} (-m ${mainline})` : `commit ${hash.slice(0, 8)}`;
  if (!confirm(`Cherry-pick ${what} onto ${branch}?`)) return;
  try {
    await api('/cherry-pick', { ref: hash, mainline, record });
    await refresh();
  } catch (err) {
    toast(`Cherry-pick failed: ${String(err)}`);
  }
}

export async function revertFromMenu(hash: string, mainline?: number): Promise<void> {
  const branch = store.lastResponse?.state?.headBranch ?? 'the current branch';
  const what = mainline !== undefined ? `commit ${hash.slice(0, 8)} (-m ${mainline})` : `commit ${hash.slice(0, 8)}`;
  if (!confirm(`Revert ${what} on ${branch}? This creates a new commit undoing its changes.`)) return;
  try {
    await api('/revert', { ref: hash, mainline });
    await refresh();
  } catch (err) {
    toast(`Revert failed: ${String(err)}`);
  }
}

export async function mergeIntoCurrent(name: string): Promise<void> {
  const branch = store.lastResponse?.state?.headBranch ?? 'the current branch';
  if (!confirm(`Merge ${name} into ${branch}?`)) return;
  try {
    await api('/merge', { ref: name });
    await refresh();
  } catch (err) {
    toast(`Merge failed: ${String(err)}`);
  }
}

export async function deleteBranch(name: string, remote: boolean): Promise<void> {
  const noun = remote ? `remote branch "${name}"` : `branch "${name}"`;
  if (!confirm(`Delete ${noun}?`)) return;
  try {
    await api('/branch-delete', { name, remote });
    await refresh();
  } catch (err) {
    toast(`Delete failed: ${String(err)}`);
  }
}

export async function deleteTag(name: string): Promise<void> {
  if (!confirm(`Delete tag "${name}"?`)) return;
  try {
    await api('/tag-delete', { name });
    await refresh();
  } catch (err) {
    toast(`Delete failed: ${String(err)}`);
  }
}

export async function applyStash(hash: string): Promise<void> {
  try {
    await api('/stash-apply', { hash });
    await refresh();
  } catch (err) {
    toast(`Apply failed: ${String(err)}`);
  }
}

export async function popStash(hash: string): Promise<void> {
  try {
    await api('/stash-apply', { hash });
    await api('/stash-drop', { hash });
    store.selectedHash = null;
    await refresh();
  } catch (err) {
    toast(`Pop failed: ${String(err)}`);
  }
}

export async function dropStash(hash: string): Promise<void> {
  if (!confirm('Drop this stash entry? The saved changes are discarded.')) return;
  try {
    await api('/stash-drop', { hash });
    store.selectedHash = null;
    await refresh();
  } catch (err) {
    toast(`Drop failed: ${String(err)}`);
  }
}

/** Custom confirm dialog that names the reset mode and target commit. */
export function confirmReset(mode: ResetMode, hash: string): Promise<boolean> {
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

export async function resetTo(hash: string, mode: ResetMode): Promise<void> {
  if (!(await confirmReset(mode, hash))) return;
  try {
    await api('/reset', { mode, ref: hash });
    store.selectedHash = null;
    await refresh();
  } catch (err) {
    toast(`Reset failed: ${String(err)}`);
  }
}

export function initContextMenu(): void {
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
      const commit = (store.lastResponse?.commits ?? []).find((c) => c.hash === store.selectedHash);
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
    const info = (store.lastResponse?.state?.branches ?? []).find((b) => b.name === name);
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
}
