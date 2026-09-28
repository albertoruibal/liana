// Shared display helpers for refs (local branch / remote branch / tag / HEAD).

import type { GitRef, RefKind } from './types';

export const REF_KIND_LABEL: Record<RefKind, string> = {
  head: 'HEAD',
  local: 'local',
  remote: 'remote',
  tag: 'tag',
  stash: 'stash',
};

/** Human label for a ref, e.g. "local main", "remote origin/main", "tag v1.0". */
export function refLabel(ref: GitRef): string {
  return ref.kind === 'head' ? ref.name : `${REF_KIND_LABEL[ref.kind]} ${ref.name}`;
}
