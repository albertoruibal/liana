// Create-worktree dialog: add a linked working tree at a new branch off a ref.

import { $ } from './dom';
import { refresh } from './actions';
import { api } from './api-client';
import { addRepo } from './tabs';
import { confirmDialog } from './confirm';
import { toast } from './toast';

let wtRef = '';

/**
 * Open the create-worktree dialog. `ref` is the start point the new branch is
 * created from; `branch` prefills the branch name (e.g. the source branch).
 */
export function openWorktreeDialog(ref: string, branch = ''): void {
  wtRef = ref;
  const short = /^[0-9a-f]{7,40}$/.test(ref) ? ref.slice(0, 8) : ref;
  $('#worktree-subtitle').textContent = `New branch from ${short}`;
  $('#worktree-error').textContent = '';
  $<HTMLInputElement>('#worktree-branch').value = branch;
  $<HTMLInputElement>('#worktree-path').value = '';
  $<HTMLInputElement>('#worktree-ref').value = ref;
  $<HTMLDialogElement>('#worktree-dialog').showModal();
  $<HTMLInputElement>('#worktree-path').focus();
}

export function initWorktree(): void {
  $('#worktree-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const dest = $<HTMLInputElement>('#worktree-path').value.trim();
    const branch = $<HTMLInputElement>('#worktree-branch').value.trim();
    const ref = $<HTMLInputElement>('#worktree-ref').value.trim() || wtRef;
    if (!dest) {
      $('#worktree-error').textContent = 'Path required';
      return;
    }
    if (!branch) {
      $('#worktree-error').textContent = 'Branch name required';
      return;
    }
    if (!ref) {
      $('#worktree-error').textContent = 'Start point required';
      return;
    }
    void (async () => {
      try {
        await api('/worktree-add', { path: dest, branch, ref });
        $<HTMLDialogElement>('#worktree-dialog').close();
        await refresh();
        if (
          await confirmDialog({
            title: 'Worktree created',
            message: `Worktree created at ${dest}. Open it in a new tab?`,
            confirmLabel: 'Open in new tab',
          })
        ) {
          try {
            await addRepo(dest, true);
          } catch (err) {
            toast(String(err));
          }
        }
      } catch (err) {
        $('#worktree-error').textContent = String(err);
      }
    })();
  });

  $('#worktree-cancel').addEventListener('click', () => {
    $<HTMLDialogElement>('#worktree-dialog').close();
  });
}
