// Cherry-pick dialog: pick a commit onto the checked-out branch, choosing a
// mainline parent for merges and optionally recording the source (-x).

import { api } from './api-client';
import { $ } from './dom';
import { store } from './store';
import { refresh } from './actions';

let cherryPickHash = '';

/**
 * Open the cherry-pick dialog for `hash`. The mainline selector is shown only
 * for merge commits (git requires `-m N` there).
 */
export function openCherryPickDialog(hash: string): void {
  if (!hash) return;
  cherryPickHash = hash;
  const branch = store.lastResponse?.state?.headBranch ?? 'the current branch';
  const short = hash.slice(0, 8);
  const commit = (store.lastResponse?.commits ?? []).find((c) => c.hash === hash);
  $('#cherry-pick-subtitle').textContent = `Cherry-pick ${short} onto ${branch}.`;
  $('#cherry-pick-status').textContent = '';
  $<HTMLInputElement>('#cherry-pick-record').checked = false;
  const mainlineLabel = $('#cherry-pick-mainline-label');
  const select = $<HTMLSelectElement>('#cherry-pick-mainline');
  const parents = commit?.parents ?? [];
  if (parents.length >= 2) {
    select.replaceChildren();
    parents.forEach((_p, i) => {
      const opt = document.createElement('option');
      opt.value = String(i + 1);
      opt.textContent = `Parent ${i + 1} — ${parents[i]?.slice(0, 8) ?? ''}`;
      select.appendChild(opt);
    });
    select.value = '1';
    mainlineLabel.hidden = false;
  } else {
    mainlineLabel.hidden = true;
  }
  $<HTMLDialogElement>('#cherry-pick-dialog').showModal();
}

export async function submitCherryPick(): Promise<void> {
  if (!cherryPickHash) return;
  const record = $<HTMLInputElement>('#cherry-pick-record').checked;
  const mainlineLabel = $('#cherry-pick-mainline-label');
  const mainline = mainlineLabel.hidden
    ? undefined
    : Number($<HTMLSelectElement>('#cherry-pick-mainline').value);
  const status = $('#cherry-pick-status');
  try {
    await api('/cherry-pick', { ref: cherryPickHash, mainline, record });
    cherryPickHash = '';
    $<HTMLDialogElement>('#cherry-pick-dialog').close();
    await refresh();
  } catch (err) {
    status.textContent = String(err);
  }
}

export function initCherryPick(): void {
  $('#cherry-pick-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    void submitCherryPick();
  });

  $('#cherry-pick-cancel').addEventListener('click', () => {
    cherryPickHash = '';
    $<HTMLDialogElement>('#cherry-pick-dialog').close();
  });
}
