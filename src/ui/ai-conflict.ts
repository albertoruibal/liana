// AI conflict-resolution dialog: request, preview, and apply a model-proposed merge.

import { api } from './api-client';
import { esc } from './format';
import { $ } from './dom';
import { AiConflictFix } from '../types';
import { refresh } from './actions';

// --- AI conflict resolution dialog ---
/** The last model proposal, applied when the user confirms. */
export let aiConflictFix: AiConflictFix | null = null;

/** Path the AI dialog is working on, so Regenerate can re-ask. */
export let aiConflictPath = '';

/** Guards against a stale proposal landing after the dialog was reopened. */
export let aiConflictSeq = 0;

/** Open the AI merge dialog for one conflicted path and request a proposal. */
export async function openAiConflictDialog(path: string): Promise<void> {
  if (!path) return;
  aiConflictPath = path;
  $<HTMLButtonElement>('#ai-conflict-apply').disabled = true;
  $<HTMLButtonElement>('#ai-conflict-regenerate').disabled = true;
  $('#ai-conflict-title').textContent = path;
  $('#ai-conflict-subtitle').textContent = '';
  $('#ai-conflict-status').textContent = '';
  $('#ai-conflict-body').innerHTML = '';
  $<HTMLDialogElement>('#ai-conflict-dialog').showModal();
  await requestAiConflictFix(path);
}

/** Ask the backend for a proposed merge and render it. */
export async function requestAiConflictFix(path: string): Promise<void> {
  const seq = ++aiConflictSeq;
  aiConflictFix = null;
  const applyBtn = $<HTMLButtonElement>('#ai-conflict-apply');
  const regenBtn = $<HTMLButtonElement>('#ai-conflict-regenerate');
  applyBtn.disabled = true;
  regenBtn.disabled = true;
  $('#ai-conflict-subtitle').textContent = 'Asking the model to merge…';
  $('#ai-conflict-body').innerHTML = '<div class="dl-note">Waiting for the model…</div>';
  $('#ai-conflict-status').textContent = '';
  try {
    const { fix } = await api<{ fix: AiConflictFix }>('/conflict-fix', { path });
    if (seq !== aiConflictSeq) return;
    aiConflictFix = fix;
    renderAiConflictDialog(fix);
    applyBtn.disabled = false;
  } catch (err) {
    if (seq !== aiConflictSeq) return;
    $('#ai-conflict-subtitle').textContent = '';
    $('#ai-conflict-body').innerHTML = '';
    $('#ai-conflict-status').textContent = String(err);
  } finally {
    if (seq === aiConflictSeq) regenBtn.disabled = false;
  }
}

/** Render a proposed merge: explanation plus the merged file (or a delete note). */
export function renderAiConflictDialog(fix: AiConflictFix): void {
  const suffix = fix.kind === 'delete' ? ' · resolves by deletion' : '';
  $('#ai-conflict-subtitle').textContent = `Proposed by ${fix.model}${suffix}`;
  const explanation = fix.explanation
    ? `<p class="ai-conflict-explanation">${esc(fix.explanation)}</p>`
    : '';
  const body =
    fix.kind === 'delete'
      ? '<div class="dl-note">The model proposes removing this file.</div>'
      : `<pre class="ai-conflict-pre">${esc(fix.content ?? '')}</pre>`;
  $('#ai-conflict-body').innerHTML = explanation + body;
}

/** Apply the reviewed proposal: the backend writes the file and stages it. */
export async function applyAiConflictFix(): Promise<void> {
  const fix = aiConflictFix;
  if (!fix) return;
  const status = $('#ai-conflict-status');
  const applyBtn = $<HTMLButtonElement>('#ai-conflict-apply');
  applyBtn.disabled = true;
  const verb = fix.kind === 'delete' ? 'remove' : 'overwrite';
  if (!confirm(`Apply the AI merge? This will ${verb} ${fix.path} and stage it.`)) {
    applyBtn.disabled = false;
    return;
  }
  try {
    await api('/conflict-apply', { path: fix.path, kind: fix.kind, content: fix.content });
    $<HTMLDialogElement>('#ai-conflict-dialog').close();
    await refresh();
  } catch (err) {
    status.textContent = String(err);
    applyBtn.disabled = false;
  }
}

export function initAiConflict(): void {
  $('#ai-conflict-close').addEventListener('click', (ev) => {
    ev.preventDefault();
    aiConflictSeq++;
    $<HTMLDialogElement>('#ai-conflict-dialog').close();
  });

  $('#ai-conflict-regenerate').addEventListener('click', () => void requestAiConflictFix(aiConflictPath));

  $('#ai-conflict-apply').addEventListener('click', () => void applyAiConflictFix());
}

/** Invalidate any in-flight proposal so a stale reply is dropped. */
export function invalidateAiConflict(): void {
  aiConflictSeq++;
}
