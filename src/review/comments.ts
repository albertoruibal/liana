// Validation and parsing of model-produced review comments. Node-only.

import { matchesAnyGlob } from '../review-tools';
import { parsePatch } from '../diff';
import type {
  ReviewComment,
  ReviewCommentStage,
  ReviewFile,
  ReviewRuleConfig,
  ReviewSeverity,
} from '../types';

/** Line numbers actually present in a file's diff, for anchor validation. */
interface LineAnchors {
  newLines: Set<number>;
  oldLines: Set<number>;
}

/**
 * Collect the old/new line numbers each changed file's diff actually touches.
 * A line anchor outside this set does not exist in the diff and cannot be
 * positioned on the forge. Memoized per file list: streamed previews re-validate
 * repeatedly against the same unchanged diffs.
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

/** Validate and normalize one raw model comment; null when it must be dropped. */
function validateComment(
  raw: unknown,
  known: Set<string>,
  rule: ReviewRuleConfig,
  id: string,
  stage: ReviewCommentStage,
  anchors: Map<string, LineAnchors>,
): ReviewComment | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const c = raw as Record<string, unknown>;
  const filePath = typeof c.filePath === 'string' ? c.filePath : typeof c.path === 'string' ? c.path : '';
  const body = typeof c.body === 'string' ? c.body.trim() : typeof c.comment === 'string' ? c.comment.trim() : '';
  if (!filePath || !body) return null;
  if (known.size > 0 && !known.has(filePath)) return null;
  if (matchesAnyGlob(filePath, rule.ignoreGlobs)) return null;
  const severity = coerceSeverity(c.severity);
  if (SEVERITY_RANK[severity] < SEVERITY_RANK[rule.severityThreshold]) return null;
  let newLine = typeof c.newLine === 'number' && c.newLine > 0 ? Math.floor(c.newLine) : null;
  let oldLine = typeof c.oldLine === 'number' && c.oldLine > 0 ? Math.floor(c.oldLine) : null;
  const line = typeof c.line === 'number' && c.line > 0 ? Math.floor(c.line) : null;
  newLine = newLine ?? (oldLine === null ? line : null);
  // An anchor that is not present in the diff cannot be positioned: drop it so
  // the comment degrades to a general one rather than a stale line reference.
  const a = anchors.get(filePath);
  if (a) {
    if (newLine !== null && !a.newLines.has(newLine)) newLine = null;
    if (oldLine !== null && !a.oldLines.has(oldLine)) oldLine = null;
  }
  return {
    id,
    filePath,
    oldLine,
    newLine,
    severity,
    body,
    status: 'pending',
    stage,
    discussionId: null,
    error: null,
  };
}

/** Validate, filter, and cap the model's raw comment objects. */
export function parseComments(
  raw: unknown,
  rule: ReviewRuleConfig,
  files: ReviewFile[],
): ReviewComment[] {
  const container =
    typeof raw === 'object' && raw !== null
      ? ((raw as Record<string, unknown>).comments ?? raw)
      : raw;
  if (!Array.isArray(container)) return [];
  const known = new Set(files.flatMap((f) => [f.newPath, f.oldPath]));
  const anchors = buildAnchors(files);
  const out: ReviewComment[] = [];
  for (const item of container) {
    const c = validateComment(item, known, rule, `c${out.length + 1}`, 'parsed', anchors);
    if (c) out.push(c);
  }
  return rule.maxComments > 0 ? out.slice(0, rule.maxComments) : out;
}

/** Yield every complete, balanced JSON object found in text, in order. */
function scanJsonObjects(text: string): Record<string, unknown>[] {
  const cleaned = text.replace(/```(?:json)?/gi, '');
  const out: Record<string, unknown>[] = [];
  const stack: number[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (c === undefined) break;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') stack.push(i);
    else if (c === '}') {
      const start = stack.pop();
      if (start === undefined) continue;
      try {
        const parsed = JSON.parse(cleaned.slice(start, i + 1)) as unknown;
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          out.push(parsed as Record<string, unknown>);
        }
      } catch {
        // Incomplete or invalid fragment; ignore and keep scanning.
      }
    }
  }
  return out;
}

/**
 * Scan partial model output for complete comment objects. These are previews
 * (`stage: 'pending'`) validated with the same rules as the final result, so the
 * live list can only ever show comments the final parse would also accept.
 */
export function parsePartialComments(
  text: string,
  rule: ReviewRuleConfig,
  files: ReviewFile[],
): ReviewComment[] {
  const known = new Set(files.flatMap((f) => [f.newPath, f.oldPath]));
  const anchors = buildAnchors(files);
  const out: ReviewComment[] = [];
  for (const obj of scanJsonObjects(text)) {
    const c = validateComment(obj, known, rule, `p${out.length + 1}`, 'pending', anchors);
    if (c) out.push(c);
  }
  return rule.maxComments > 0 ? out.slice(0, rule.maxComments) : out;
}
