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

/** Branch name a remote-tracking ref points at: "origin/feature" -> "feature". */
export function remoteBranchName(name: string): string {
  const slash = name.indexOf('/');
  return slash >= 0 ? name.slice(slash + 1) : name;
}

/** A ref as rendered: one display pill that may merge a local branch with its remote twin. */
export interface DisplayRef {
  /** Kind driving the pill tone and context menu; 'local' when a local/remote pair is merged. */
  kind: RefKind;
  /** Text shown next to the icon(s); for a remote-only ref this drops the "<remote>/" prefix. */
  name: string;
  /** Icons drawn left to right. */
  icons: RefKind[];
  /** True when this pill merges a local branch and its remote-tracking ref. */
  merged: boolean;
  /** Full human label (keeps the remote prefix), for tooltips. */
  title: string;
  /**
   * Ref name the backend actions expect. For a remote-only ref this keeps the
   * "<remote>/" prefix (`origin/release`); for a merged pill it is the local
   * branch name, so the context menu treats the merged pill as that branch.
   */
  menuName: string;
}

/**
 * Collapse a commit's refs for display. A local branch and the remote-tracking
 * ref that mirrors it (`main` + `origin/main`) become one pill carrying both
 * icons; remote-only refs drop the "<remote>/" prefix and show just the icon
 * plus branch name.
 */
export function displayRefs(refs: GitRef[]): DisplayRef[] {
  const localNames = new Set<string>();
  for (const r of refs) if (r.kind === 'local') localNames.add(r.name);

  // Pair each local branch with the first remote-tracking ref that mirrors it.
  const remoteFor = new Map<string, GitRef>();
  const paired = new Set<GitRef>();
  for (const r of refs) {
    if (r.kind !== 'remote') continue;
    const branch = remoteBranchName(r.name);
    if (branch !== r.name && localNames.has(branch) && !remoteFor.has(branch)) {
      remoteFor.set(branch, r);
      paired.add(r);
    }
  }

  const out: DisplayRef[] = [];
  const emitted = new Set<string>();
  for (const r of refs) {
    if (r.kind === 'remote') {
      if (paired.has(r)) continue;
      out.push({
        kind: 'remote',
        name: remoteBranchName(r.name),
        icons: ['remote'],
        merged: false,
        title: `remote ${r.name}`,
        menuName: r.name,
      });
    } else if (r.kind === 'local') {
      const remote = remoteFor.get(r.name);
      if (remote) {
        if (emitted.has(r.name)) continue;
        emitted.add(r.name);
        out.push({
          kind: 'local',
          name: r.name,
          icons: ['local', 'remote'],
          merged: true,
          title: `local ${r.name} · remote ${remote.name}`,
          menuName: r.name,
        });
      } else {
        out.push({ kind: 'local', name: r.name, icons: ['local'], merged: false, title: `local ${r.name}`, menuName: r.name });
      }
    } else {
      out.push({
        kind: r.kind,
        name: r.name,
        icons: r.kind === 'head' ? [] : [r.kind],
        merged: false,
        title: refLabel(r),
        menuName: r.name,
      });
    }
  }
  return out;
}

/** Inline `<svg>` icon markup for a ref kind, or `''` for HEAD. */
export function refIconHtml(kind: RefKind): string {
  const paths = REF_ICON_PATHS[kind];
  if (paths.length === 0) return '';
  const body = paths.map((d) => `<path d="${d}" />`).join('');
  return `<svg class="ref-icon ref-icon-${kind}" viewBox="0 0 16 16" aria-hidden="true">${body}</svg>`;
}
