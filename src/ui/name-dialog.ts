// Create branch / tag dialog.

import { $ } from './dom';
import { refresh } from './actions';
import { api } from './api-client';

// --- Create branch / tag dialog ---
export type NameMode = 'branch' | 'tag';

export let nameMode: NameMode = 'branch';

export let nameRef = '';

export function openNameDialog(mode: NameMode, ref: string): void {
  nameMode = mode;
  nameRef = ref;
  $('#name-title').textContent = mode === 'branch' ? 'Create branch' : 'Create tag';
  $('#name-subtitle').textContent = `At commit ${ref.slice(0, 8)}`;
  $('#name-error').textContent = '';
  const input = $<HTMLInputElement>('#name-input');
  input.value = '';
  $<HTMLButtonElement>('#name-submit').textContent = mode === 'branch' ? 'Create & checkout' : 'Create tag';
  $<HTMLDialogElement>('#name-dialog').showModal();
  input.focus();
}

export function initNameDialog(): void {
  // Submit (not click) so Enter in the name field creates the ref instead of
  // implicitly activating Cancel, the first submit button.
  $('#name-form').addEventListener('submit', (ev) => {
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

  $('#name-cancel').addEventListener('click', () => {
    $<HTMLDialogElement>('#name-dialog').close();
  });
}
