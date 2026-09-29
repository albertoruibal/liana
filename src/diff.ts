// Pure parsing of unified-diff text (as produced by `git show`) into hunks with
// old/new line numbers, plus a pairing helper for side-by-side rendering.
// Browser-safe: no Node imports.

export type DiffLineKind = 'meta' | 'hunk' | 'context' | 'add' | 'del' | 'nonewline';

export interface DiffLine {
  kind: DiffLineKind;
  /** 1-based line number in the old file, or null when the line is added/meta. */
  oldNo: number | null;
  /** 1-based line number in the new file, or null when the line is deleted/meta. */
  newNo: number | null;
  /** Line content after the diff prefix; full text for meta/hunk/nonewline lines. */
  text: string;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface DiffSection {
  meta: DiffLine[];
  hunks: DiffHunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Split a patch into file sections, each with hunk headers and line-numbered lines. */
export function parsePatch(patch: string): DiffSection[] {
  const sections: DiffSection[] = [];
  let section: DiffSection = { meta: [], hunks: [] };
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  const push = (): void => {
    if (section.meta.length > 0 || section.hunks.length > 0) sections.push(section);
    section = { meta: [], hunks: [] };
  };

  for (const raw of patch.split('\n')) {
    if (raw === '' && hunk === null) continue;

    if (raw.startsWith('diff --git ')) {
      push();
      hunk = null;
      section.meta.push({ kind: 'meta', oldNo: null, newNo: null, text: raw });
      continue;
    }

    const m = HUNK_RE.exec(raw);
    if (m) {
      oldNo = Number(m[1]);
      newNo = Number(m[2]);
      hunk = { header: raw, oldStart: oldNo, newStart: newNo, lines: [] };
      section.hunks.push(hunk);
      continue;
    }

    if (hunk === null) {
      section.meta.push({ kind: 'meta', oldNo: null, newNo: null, text: raw });
      continue;
    }

    if (raw.startsWith('\\')) {
      hunk.lines.push({ kind: 'nonewline', oldNo: null, newNo: null, text: raw });
    } else if (raw.startsWith('+')) {
      hunk.lines.push({ kind: 'add', oldNo: null, newNo: newNo++, text: raw.slice(1) });
    } else if (raw.startsWith('-')) {
      hunk.lines.push({ kind: 'del', oldNo: oldNo++, newNo: null, text: raw.slice(1) });
    } else {
      // Context lines begin with a space; treat a stray blank as context too.
      const text = raw.startsWith(' ') ? raw.slice(1) : raw;
      hunk.lines.push({ kind: 'context', oldNo: oldNo++, newNo: newNo++, text });
    }
  }
  push();
  return sections;
}

/** One side-by-side row: the old-file cell and the new-file cell (either may be null). */
export type SplitRow = [DiffLine | null, DiffLine | null];

/**
 * Pair a hunk's deleted and added runs by index for a two-column view. Context lines
 * appear on both sides; runs of deletions/additions are aligned and blank-padded.
 */
export function pairHunk(hunk: DiffHunk): SplitRow[] {
  const rows: SplitRow[] = [];
  const lines = hunk.lines;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line) break;
    if (line.kind === 'context') {
      rows.push([line, line]);
      i++;
      continue;
    }
    if (line.kind === 'nonewline') {
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length) {
      const cur = lines[i];
      if (!cur) break;
      // Skip "no newline" markers so a delete/add pair separated by one still aligns.
      if (cur.kind === 'nonewline') {
        i++;
        continue;
      }
      if (cur.kind !== 'add' && cur.kind !== 'del') break;
      if (cur.kind === 'del') dels.push(cur);
      else adds.push(cur);
      i++;
    }
    const n = Math.max(dels.length, adds.length);
    for (let j = 0; j < n; j++) rows.push([dels[j] ?? null, adds[j] ?? null]);
  }
  return rows;
}
