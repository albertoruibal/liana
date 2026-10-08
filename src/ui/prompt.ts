// Reusable modal single-text prompt, replacing window.prompt(). Electron has
// no window.prompt, and the browser one is unstyled; both use this dialog.

import { $ } from './dom';

/** Pending resolver for the single-text prompt, or null when no prompt is open. */
let inputResolve: ((value: string | null) => void) | null = null;

/**
 * Modal single-text prompt. Resolves to the (untrimmed) value, or null when
 * cancelled.
 */
export function promptText(title: string, label: string, value = ''): Promise<string | null> {
  $('#wt-input-title').textContent = title;
  $('#wt-input-subtitle').textContent = '';
  $('#wt-input-label').textContent = label;
  $('#wt-input-error').textContent = '';
  const field = $<HTMLInputElement>('#wt-input-field');
  field.value = value;
  const dlg = $<HTMLDialogElement>('#wt-input-dialog');
  return new Promise((resolve) => {
    inputResolve = resolve;
    dlg.showModal();
    field.focus();
    field.select();
  });
}

export function initPrompt(): void {
  const resolveInput = (value: string | null): void => {
    const resolve = inputResolve;
    inputResolve = null;
    resolve?.(value);
  };
  $('#wt-input-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const value = $<HTMLInputElement>('#wt-input-field').value;
    $<HTMLDialogElement>('#wt-input-dialog').close();
    resolveInput(value);
  });
  $<HTMLDialogElement>('#wt-input-dialog').addEventListener('close', () => resolveInput(null));
  $('#wt-input-cancel').addEventListener('click', () => {
    $<HTMLDialogElement>('#wt-input-dialog').close();
  });
}
