// Read-only whole-file Monaco viewer.

import { api } from './api-client';
import { loadCode } from './code-loader';
import { esc } from './format';
import { $ } from './dom';
import { CodeHandle } from '../code';
import { FileContents } from '../types';

/** Monaco handle for the read-only whole-file viewer, or null when not mounted. */
export let codeViewerHandle: CodeHandle | null = null;

/** Dispose the open whole-file viewer editor, if any. */
export function disposeCodeViewer(): void {
  codeViewerHandle?.dispose();
  codeViewerHandle = null;
}

/** Open the read-only whole-file viewer at a commit or in the working tree. */
export async function openCodeViewer(path: string, hash: string | null): Promise<void> {
  if (!path) return;
  const dlg = $<HTMLDialogElement>('#code-dialog');
  const body = $<HTMLDivElement>('#code-body');
  $('#code-title').textContent = path;
  $('#code-subtitle').textContent = hash
    ? `commit ${hash.slice(0, 8)} · read-only`
    : 'working tree · read-only';
  $('#code-status').textContent = '';
  disposeCodeViewer();
  body.textContent = 'Loading file…';
  dlg.showModal();
  try {
    const contents = await api<FileContents>('/file-content', { hash, path, oldPath: null });
    if (contents.binary) {
      body.textContent = '';
      body.innerHTML = '<div class="dl-note">Binary file — cannot display.</div>';
      return;
    }
    const code = await loadCode();
    const value = contents.modified ?? contents.original ?? '';
    body.textContent = '';
    if (!code) {
      body.innerHTML = `<pre class="conflict-pre">${esc(value)}</pre>`;
      return;
    }
    codeViewerHandle = code.createEditor(body, value, { path, readOnly: true });
  } catch (err) {
    body.textContent = '';
    $('#code-status').textContent = String(err);
  }
}

export function initCodeViewer(): void {
  $('#code-close').addEventListener('click', (ev) => {
    ev.preventDefault();
    disposeCodeViewer();
    $<HTMLDialogElement>('#code-dialog').close();
  });

  $<HTMLDialogElement>('#code-dialog').addEventListener('close', () => disposeCodeViewer());
}
