// Toolbar "three dots" menu.

import { $ } from './dom';
import { closeStatusHistory, statusHistory } from './status-bar';

// --- Toolbar "three dots" menu ---
export const moreMenu = $('#more-menu');

export const moreButton = $('#btn-more');

export function closeMoreMenu(): void {
  moreMenu.hidden = true;
  moreButton.setAttribute('aria-expanded', 'false');
}

export function initMoreMenu(): void {
  $('#btn-about').addEventListener('click', () => {
    $('#about-version').textContent = __APP_VERSION__;
    closeMoreMenu();
    $<HTMLDialogElement>('#about-dialog').showModal();
  });

  $('#about-close').addEventListener('click', (ev) => {
    ev.preventDefault();
    $<HTMLDialogElement>('#about-dialog').close();
  });

  $('#btn-more').addEventListener('click', () => {
    if (!moreMenu.hidden) {
      closeMoreMenu();
      return;
    }
    moreMenu.hidden = false;
    moreButton.setAttribute('aria-expanded', 'true');
    const rect = moreButton.getBoundingClientRect();
    moreMenu.style.top = `${rect.bottom + 6}px`;
    moreMenu.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
    moreMenu.style.left = 'auto';
  });

  document.addEventListener('pointerdown', (ev) => {
    if (!moreMenu.hidden && !moreMenu.contains(ev.target as Node) && !moreButton.contains(ev.target as Node)) {
      closeMoreMenu();
    }
    if (
      !statusHistory.hidden &&
      !statusHistory.contains(ev.target as Node) &&
      !$('#status-command').contains(ev.target as Node)
    ) {
      closeStatusHistory();
    }
  });

  window.addEventListener('resize', () => {
    closeMoreMenu();
    closeStatusHistory();
  });
}
