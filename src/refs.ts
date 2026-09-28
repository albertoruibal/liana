// Shared display helpers for refs (local branch / remote branch / tag / HEAD).

import type { GitRef, RefKind } from './types';

export const REF_KIND_LABEL: Record<RefKind, string> = {
  head: 'HEAD',
  local: 'local',
  remote: 'remote',
  tag: 'tag',
  stash: 'stash',
};

/**
 * Icon geometry for each ref kind, as SVG path data on a 16x16 canvas stroked
 * with `currentColor`. HEAD has no icon (it is a label, not a ref origin).
 */
export const REF_ICON_PATHS: Record<RefKind, readonly string[]> = {
  head: [],
  // Two nodes joined by a branch line.
  local: [
    'M4.9 4.4 V11.6',
    'M11.1 4.6 V6.1 A3.1 3.1 0 0 1 8 9.2 H4.9',
    'M3.6 3.2 a1.3 1.3 0 1 0 2.6 0 a1.3 1.3 0 1 0 -2.6 0',
    'M3.6 12.8 a1.3 1.3 0 1 0 2.6 0 a1.3 1.3 0 1 0 -2.6 0',
    'M9.8 3.2 a1.3 1.3 0 1 0 2.6 0 a1.3 1.3 0 1 0 -2.6 0',
  ],
  // Globe: the ref lives on another machine.
  remote: [
    'M2.5 8 a5.5 5.5 0 1 0 11 0 a5.5 5.5 0 1 0 -11 0',
    'M8 2.5 c2.2 1.6 2.2 9.4 0 11 c-2.2-1.6-2.2-9.4 0-11',
    'M2.7 6 H13.3',
    'M2.7 10 H13.3',
  ],
  // Price tag.
  tag: [
    'M2.6 2.6 H7.9 L13.4 8.1 L8.1 13.4 L2.6 7.9 Z',
    'M5.1 4.5 a1.1 1.1 0 1 0 2.2 0 a1.1 1.1 0 1 0 -2.2 0',
  ],
  // Archive box: a saved snapshot.
  stash: [
    'M2.8 5.5 H13.2 V12.6 A0.9 0.9 0 0 1 12.3 13.5 H3.7 A0.9 0.9 0 0 1 2.8 12.6 Z',
    'M2.2 2.5 H13.8 V5.5 H2.2 Z',
    'M6.6 8.4 H9.4',
  ],
};

/** Human label for a ref, e.g. "local main", "remote origin/main", "tag v1.0". */
export function refLabel(ref: GitRef): string {
  return ref.kind === 'head' ? ref.name : `${REF_KIND_LABEL[ref.kind]} ${ref.name}`;
}

/** Inline `<svg>` icon markup for a ref kind, or `''` for HEAD. */
export function refIconHtml(kind: RefKind): string {
  const paths = REF_ICON_PATHS[kind];
  if (paths.length === 0) return '';
  const body = paths.map((d) => `<path d="${d}" />`).join('');
  return `<svg class="ref-icon ref-icon-${kind}" viewBox="0 0 16 16" aria-hidden="true">${body}</svg>`;
}
