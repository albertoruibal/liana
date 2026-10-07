// Commit dialog: file list, selection, and AI commit-message drafting.

import { api } from './api-client';
import { updateCommitSelection } from './detail';
import { $ } from './dom';
import { refresh } from './actions';
import { openCodeViewer } from './code-viewer';
import { renderCommitFiles } from './detail';
import { openWorktreeDiff } from './diff-view';
import { StateResponse } from './store';
import { toast } from './toast';

/** Draft a commit message for the checked files with the active AI provider. */
export async function generateCommitMessage(): Promise<void> {
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

export function initCommitDialog(): void {
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
          toast('No local changes to stash.', 'info');
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
}
