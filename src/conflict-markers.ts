// Parse Git conflict markers into per-conflict blocks for the line picker.
// Browser-safe: no Node imports.

/** One `<<<<<<<` … `>>>>>>>` region and the Ours / Theirs (and diff3 Base) lines inside it. */
export interface ConflictMarkerBlock {
  /** 0-based index of the `<<<<<<<` line. */
  startLine: number;
  /** 0-based exclusive index just past the `>>>>>>>` line. */
  endLine: number;
  ours: string[];
  /** diff3 `|||||||` section between Ours and `=======`, or null for a two-way conflict. */
  base: string[] | null;
  theirs: string[];
}

// A marker is at least seven repeated characters at the start of a line, optionally
// followed by a label. Trailing CR is allowed so CRLF files still parse.
const OURS_RE = /^<{7,}(?:[ \t]|$)/;
const BASE_RE = /^\|{7,}(?:[ \t]|$)/;
const SEP_RE = /^={7,}[ \t\r]*$/;
const THEIRS_RE = /^>{7,}(?:[ \t]|$)/;

function isOurs(line: string): boolean {
  return OURS_RE.test(line);
}
function isBase(line: string): boolean {
  return BASE_RE.test(line);
}
function isSep(line: string): boolean {
  return SEP_RE.test(line);
}
function isTheirs(line: string): boolean {
  return THEIRS_RE.test(line);
}

/**
 * Split conflict-marker text into blocks. Only marker regions are returned; text
 * outside them (the non-conflicted context) is never part of a block. Malformed
 * or unterminated marker runs are ignored rather than throwing.
 */
export function parseConflictBlocks(text: string): ConflictMarkerBlock[] {
  const lines = text.split('\n');
  const blocks: ConflictMarkerBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!isOurs(lines[i]!)) {
      i++;
      continue;
    }
    const start = i;
    const ours: string[] = [];
    const theirs: string[] = [];
    let base: string[] | null = null;
    let sawSep = false;
    let j = i + 1;
    let closed = false;
    for (; j < lines.length; j++) {
      const line = lines[j]!;
      if (!sawSep && base === null && isBase(line)) {
        base = [];
        continue;
      }
      if (!sawSep && isSep(line)) {
        sawSep = true;
        continue;
      }
      if (sawSep && isTheirs(line)) {
        closed = true;
        break;
      }
      if (!sawSep && (isOurs(line) || isTheirs(line))) break;
      if (!sawSep) {
        (base ?? ours).push(line);
      } else {
        theirs.push(line);
      }
    }
    if (closed) {
      blocks.push({ startLine: start, endLine: j + 1, ours, base, theirs });
      i = j + 1;
    } else {
      i = start + 1;
    }
  }
  return blocks;
}
