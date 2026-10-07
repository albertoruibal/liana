// Interactive rebase dialog and branch checkout.

import { api } from './api-client';
import { esc } from './format';
import { toast } from './toast';
import { $ } from './dom';
import { store } from './store';
import { RebaseAction, RebaseTodoItem } from '../types';
import { refresh } from './actions';

// --- Interactive rebase dialog ---
export interface RebaseStartResponse {
  ok: boolean;
  onto: string;
  items: Array<{ hash: string; subject: string; author: string; timestamp: number }>;
}

export function renderRebaseTodo(
  items: Array<{ hash: string; subject: string }>,
): void {
  const ol = $<HTMLOListElement>('#rebase-todo');
  ol.innerHTML = items
    .map(
      (c) =>
        `<li data-hash="${esc(c.hash)}" data-action="pick">
          <select class="rebase-action">
            <option value="pick">pick</option>
            <option value="reword">reword</option>
            <option value="squash">squash</option>
            <option value="drop">drop</option>
          </select>
          <code>${esc(c.hash.slice(0, 8))}</code>
          <span class="rebase-subject">${esc(c.subject)}</span>
          <input class="rebase-message" type="text" placeholder="new message" />
        </li>`,
    )
    .join('');

  ol.querySelectorAll<HTMLLIElement>('li').forEach((li) => {
    const select = li.querySelector<HTMLSelectElement>('.rebase-action');
    const msg = li.querySelector<HTMLInputElement>('.rebase-message');
    if (!select || !msg) return;
    const sync = () => {
      const needsMsg = select.value === 'reword' || select.value === 'squash';
      msg.classList.toggle('visible', needsMsg);
      li.dataset.action = select.value;
    };
    select.addEventListener('change', sync);
    sync();
  });
}

/** Commit hash the open interactive-rebase dialog is based on. */
export let rebaseOnto: string | null = null;

export async function openRebaseDialog(onto: string): Promise<void> {
  if (!onto) return;
  const dlg = $<HTMLDialogElement>('#rebase-dialog');
  $('#rebase-status').textContent = '';
  try {
    const plan = await api<RebaseStartResponse>('/rebase-start', { onto });
    if (plan.items.length === 0) {
      toast('Nothing to rebase: HEAD is already based on this commit.', 'info');
      return;
    }
    $('#rebase-summary').textContent = `${plan.items.length} commit(s) to replay onto ${plan.onto.slice(0, 8)} — oldest first`;
    rebaseOnto = onto;
    renderRebaseTodo(plan.items);
    dlg.showModal();
  } catch (err) {
    toast(`Cannot start rebase: ${String(err)}`);
  }
}

export async function submitRebase(): Promise<void> {
  const dlg = $<HTMLDialogElement>('#rebase-dialog');
  const onto = rebaseOnto;
  if (!onto) return;
  const items: RebaseTodoItem[] = [];
  $('#rebase-todo')
    .querySelectorAll<HTMLLIElement>('li')
    .forEach((li) => {
      const hash = li.dataset.hash ?? '';
      const action = (li.querySelector<HTMLSelectElement>('.rebase-action')?.value ?? 'pick') as RebaseAction;
      const message = li.querySelector<HTMLInputElement>('.rebase-message')?.value.trim() || undefined;
      items.push({ hash, subject: '', author: '', timestamp: 0, action, message });
    });
  const status = $('#rebase-status');
  try {
    await api('/rebase-execute', { onto, items });
    rebaseOnto = null;
    dlg.close();
    await refresh();
  } catch (err) {
    status.textContent = String(err);
    await refresh();
  }
}

export async function checkout(branch: string, remote = false): Promise<void> {
  if (!branch) return;
  await api('/checkout', remote ? { branch, remote: true } : { branch });
  store.selectedHash = null;
  await refresh();
}

/** Local branch name a remote-tracking ref (`origin/feature`) checks out as. */
export function remoteLocalName(name: string): string | null {
  const m = /^[^/]+\/(.+)$/.exec(name);
  const branch = m?.[1] ?? '';
  return branch && branch !== 'HEAD' ? branch : null;
}

export function initRebase(): void {
  $('#rebase-submit').addEventListener('click', (ev) => {
    ev.preventDefault();
    void submitRebase();
  });

  $('#rebase-cancel').addEventListener('click', (ev) => {
    ev.preventDefault();
    rebaseOnto = null;
    $<HTMLDialogElement>('#rebase-dialog').close();
  });
}
