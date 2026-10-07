// Non-blocking toast notifications.

export type ToastKind = 'error' | 'info';

/** Auto-dismiss delay per kind; errors linger so they can be read fully. */
const TOAST_TIMEOUT: Record<ToastKind, number> = { error: 9000, info: 4000 };

/**
 * Non-blocking replacement for `alert()`: appends a dismissible toast to the
 * bottom-right region. Errors persist longer and are announced assertively.
 */
export function toast(message: string, kind: ToastKind = 'error'): void {
  const region = document.querySelector('#toast-region');
  if (!region) return;
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  const text = document.createElement('span');
  text.className = 'toast-text';
  text.textContent = message;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.setAttribute('aria-label', 'Dismiss');
  close.innerHTML =
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  el.append(text, close);
  const dismiss = (): void => {
    window.clearTimeout(timer);
    el.classList.add('toast-out');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
    // Fallback when transitions are disabled (prefers-reduced-motion).
    window.setTimeout(() => el.remove(), 300);
  };
  const timer = window.setTimeout(dismiss, TOAST_TIMEOUT[kind]);
  close.addEventListener('click', dismiss);
  region.append(el);
}
