// Typed DOM query helpers.

/** Query a single element, throwing when it is missing. */
export const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el;
};

/** Typed helper: query a single element with a precise DOM type. */
export function $svg(sel: string): SVGSVGElement {
  const el = document.querySelector(sel);
  if (!(el instanceof SVGSVGElement)) throw new Error(`missing svg element ${sel}`);
  return el;
}

/** True when the event target is a text field, so shortcuts don't hijack typing. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}
