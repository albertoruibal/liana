// Validation of model-produced review comments. Comments arrive as `add_comment`
// tool calls, not text; each call is validated against the changed files and the
// diff anchors before it becomes a proposed comment. Node-only.

import { matchesAnyGlob } from '../review-tools';
import { parsePatch } from '../diff';
import type { ReviewComment, ReviewRuleConfig, ReviewSeverity, ReviewFile } from '../types';

/** Line numbers actually present in a file's diff, for anchor validation. */
interface LineAnchors {
  newLines: Set<number>;
  oldLines: Set<number>;
}

/**
 * Collect the old/new line numbers each changed file's diff actually touches.
 * A line anchor outside this set does not exist in the diff and cannot be
 * positioned on the forge. Memoized per file list.
 */
const anchorCache = new WeakMap<ReviewFile[], Map<string, LineAnchors>>();

function buildAnchors(files: ReviewFile[]): Map<string, LineAnchors> {
  const cached = anchorCache.get(files);
  if (cached) return cached;
  const map = new Map<string, LineAnchors>();
  for (const f of files) {
    const newLines = new Set<number>();
    const oldLines = new Set<number>();
    for (const section of parsePatch(f.diff)) {
      for (const hunk of section.hunks) {
        for (const line of hunk.lines) {
          if (line.newNo !== null) newLines.add(line.newNo);
          if (line.oldNo !== null) oldLines.add(line.oldNo);
        }
      }
    }
    const anchor: LineAnchors = { newLines, oldLines };
    if (f.newPath) map.set(f.newPath, anchor);
    if (f.oldPath && f.oldPath !== f.newPath) map.set(f.oldPath, anchor);
  }
  anchorCache.set(files, map);
  return map;
}

function coerceSeverity(v: unknown): ReviewSeverity {
  return v === 'error' || v === 'warning' || v === 'info' ? v : 'info';
}

const SEVERITY_RANK: Record<ReviewSeverity, number> = { info: 0, warning: 1, error: 2 };

/** The line in `set` closest to `n`, or null when the set is empty. */
function nearestLine(set: Set<number>, n: number): number | null {
  let best: number | null = null;
  let bestDist = Infinity;
  for (const v of set) {
    const d = Math.abs(v - n);
    if (d < bestDist || (d === bestDist && (best === null || v < best))) {
      bestDist = d;
      best = v;
    }
  }
  return best;
}

/** A validated comment plus a hint explaining an adjustment, if any. */
export interface ToolComment {
  comment: ReviewComment | null;
  /** Why the comment was dropped or its anchor adjusted (null when clean). */
  hint: string | null;
}

/**
 * Validate one `add_comment` tool call. A comment targeting an unknown or
 * excluded file, or below the severity threshold, is dropped with a reason; an
 * anchor not present in the diff is cleared with a hint pointing at the nearest
 * line, so the model can correct itself instead of the comment disappearing.
 */
export function commentFromTool(
  raw: Record<string, unknown>,
  rule: ReviewRuleConfig,
  files: ReviewFile[],
  id: string,
): ToolComment {
  const filePath = typeof raw.filePath === 'string' ? raw.filePath.trim() : '';
  const body = typeof raw.body === 'string' ? raw.body.trim() : '';
  if (!filePath || !body) return { comment: null, hint: 'filePath and body are required' };
  const known = new Set(files.flatMap((f) => [f.newPath, f.oldPath]));
  if (known.size > 0 && !known.has(filePath)) {
    return { comment: null, hint: `${filePath} is not a changed file` };
  }
  if (matchesAnyGlob(filePath, rule.ignoreGlobs)) {
    return { comment: null, hint: `${filePath} is excluded by the ignore rules` };
  }
  const severity = coerceSeverity(raw.severity);
  if (SEVERITY_RANK[severity] < SEVERITY_RANK[rule.severityThreshold]) {
    return {
      comment: null,
      hint: `severity ${severity} is below the configured minimum ${rule.severityThreshold}`,
    };
  }
  const hints: string[] = [];
  let newLine = typeof raw.newLine === 'number' && raw.newLine > 0 ? Math.floor(raw.newLine) : null;
  let oldLine = typeof raw.oldLine === 'number' && raw.oldLine > 0 ? Math.floor(raw.oldLine) : null;
  const anchors = buildAnchors(files).get(filePath);
  if (anchors) {
    if (newLine !== null && !anchors.newLines.has(newLine)) {
      const near = nearestLine(anchors.newLines, newLine);
      hints.push(
        near !== null
          ? `newLine ${newLine} is not in the diff; nearest new-side line is ${near}`
          : `newLine ${newLine} is not in the diff`,
      );
      newLine = null;
    }
    if (oldLine !== null && !anchors.oldLines.has(oldLine)) {
      const near = nearestLine(anchors.oldLines, oldLine);
      hints.push(
        near !== null
          ? `oldLine ${oldLine} is not in the diff; nearest old-side line is ${near}`
          : `oldLine ${oldLine} is not in the diff`,
      );
      oldLine = null;
    }
  }
  return {
    comment: {
      id,
      filePath,
      oldLine,
      newLine,
      severity,
      body,
      status: 'pending',
      stage: 'parsed',
      discussionId: null,
      error: null,
    },
    hint: hints.length > 0 ? hints.join('; ') : null,
  };
}
