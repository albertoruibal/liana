// Resizable detail pane.

import { $ } from './dom';

// Resizable detail pane.
const DETAIL_WIDTH_KEY = 'liana-detail-width';
const DETAIL_MIN = 200;
const DETAIL_MAX = 720;

function setDetailWidth(width: number): void {
  const main = document.querySelector('main');
  if (!main) return;
  const max = Math.min(DETAIL_MAX, Math.max(DETAIL_MIN, main.clientWidth - DETAIL_MIN));
  const clamped = Math.min(max, Math.max(DETAIL_MIN, width));
  document.documentElement.style.setProperty('--detail-width', `${clamped}px`);
  localStorage.setItem(DETAIL_WIDTH_KEY, String(clamped));
}

export function initDetailResizer(): void {
  const resizer = $('#detail-resizer');
  const saved = Number(localStorage.getItem(DETAIL_WIDTH_KEY));
  if (Number.isFinite(saved) && saved > 0) setDetailWidth(saved);

  const onMove = (ev: PointerEvent) => {
    const main = document.querySelector('main');
    if (!main) return;
    const rect = main.getBoundingClientRect();
    setDetailWidth(rect.right - ev.clientX);
  };
  const onUp = () => {
    resizer.classList.remove('dragging');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  };
  resizer.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    resizer.classList.add('dragging');
    resizer.setPointerCapture(ev.pointerId);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
}
