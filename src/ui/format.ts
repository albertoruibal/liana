// Small HTML/formatting helpers shared by the renderers.

import { avatarColor, initials } from '../graph';
import { remoteBranchName } from '../refs';
import type { CommitFile } from '../types';
import { store } from './store';

// Small HTML/formatting helpers shared by the renderers.
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Initials avatar markup (shared with the graph's SVG avatars). */
export function avatarHtml(name: string, small = false): string {
  return `<span class="avatar${small ? ' avatar-sm' : ''}" style="background:${avatarColor(name)}">${esc(initials(name))}</span>`;
}

/** Map a porcelain status char to a badge class. */
export function statusClass(ch: string): string {
  switch (ch) {
    case 'A':
      return 's-add';
    case 'D':
      return 's-del';
    case 'R':
    case 'C':
      return 's-ren';
    case '?':
      return 's-unt';
    default:
      return 's-mod';
  }
}

/** Right-aligned line-number cell, empty when the side has no line. */
export function gutter(no: number | null): string {
  return `<span class="dl-no">${no ?? ''}</span>`;
}

/** `+N − M` line counts for a changed file, or a binary marker. */
export function fileStatHtml(file: CommitFile): string {
  if (file.binary) return '<span class="file-stat binary">bin</span>';
  const add = file.additions ?? 0;
  const del = file.deletions ?? 0;
  let out = '';
  if (add > 0) out += `<span class="file-stat add">+${add}</span>`;
  if (del > 0) out += `<span class="file-stat del">−${del}</span>`;
  return out;
}

/** One-line upstream sync summary shown on the repo overview. */
export function syncSummaryHtml(): string {
  const rs = store.remoteStatus;
  if (!rs) return '';
  if (rs.remotes.length === 0) {
    return '<p class="sync-status muted">No remote configured — add one with <code>git remote add</code> to push or pull.</p>';
  }
  if (!rs.upstream) return '';
  const parts: string[] = [];
  if (rs.ahead > 0) parts.push(`${rs.ahead} ahead`);
  if (rs.behind > 0) parts.push(`${rs.behind} behind`);
  const divergence = parts.length > 0 ? ` · ${parts.join(', ')}` : ' · up to date';
  return `<p class="sync-status"><code>${esc(rs.upstream)}</code>${divergence}</p>`;
}

/** Branch label markup for the branch list, hiding the remote prefix. */
export function branchLabel(name: string, remote: boolean): string {
  return remote ? remoteBranchName(name) : name;
}
