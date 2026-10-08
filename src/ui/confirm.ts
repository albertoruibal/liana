// Reusable styled confirmation dialog, replacing window.confirm(). Feature
// modules call `confirmDialog` and await the user's answer.

import { $ } from './dom';

export interface ConfirmOptions {
  /** Dialog heading, e.g. "Delete branch?" */
  title: string;
  /** Body text; set as textContent, so it may contain any characters. */
  message: string;
  /** Label for the affirmative button (default "Confirm"). */
  confirmLabel?: string;
  /** Style the affirmative button as destructive. */
  danger?: boolean;
  /** Optional extra warning rendered in the dirty banner. */
  warning?: string;
}

/** True while a confirmation is showing; only one can be open at a time. */
let open = false;

/**
 * Show a modal confirmation and resolve true when the user accepts. Confirming
 * dialogs are modal, so a call while one is already open resolves false
 * immediately rather than stacking.
 */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  if (open) return Promise.resolve(false);
  open = true;

  const dlg = $<HTMLDialogElement>('#confirm-dialog');
  const okBtn = $<HTMLButtonElement>('#confirm-ok');
  const cancelBtn = $<HTMLButtonElement>('#confirm-cancel');
  $('#confirm-title').textContent = opts.title;
  $('#confirm-message').textContent = opts.message;
  const warning = $('#confirm-warning');
  if (opts.warning) {
    $('#confirm-warning-text').textContent = opts.warning;
    warning.hidden = false;
  } else {
    warning.hidden = true;
  }
  okBtn.textContent = opts.confirmLabel ?? 'Confirm';
  okBtn.classList.toggle('btn-danger', opts.danger ?? false);
  okBtn.classList.toggle('btn-primary', !(opts.danger ?? false));

  return new Promise((resolve) => {
    const finish = (value: boolean): void => {
      if (!open) return;
      open = false;
      okBtn.removeEventListener('click', onConfirm);
      cancelBtn.removeEventListener('click', onCancel);
      dlg.removeEventListener('cancel', onCancel);
      dlg.removeEventListener('close', onClose);
      if (dlg.open) dlg.close();
      resolve(value);
    };
    const onConfirm = (): void => finish(true);
    const onCancel = (): void => finish(false);
    // `cancel` (Esc) and footer clicks route here; `close` is a safety net for a
    // direct dlg.close() from the global Escape handler, which fires `close`
    // rather than `cancel`.
    const onClose = (): void => finish(false);
    okBtn.addEventListener('click', onConfirm);
    cancelBtn.addEventListener('click', onCancel);
    dlg.addEventListener('cancel', onCancel);
    dlg.addEventListener('close', onClose);
    dlg.showModal();
  });
}
