// Validation and parsing of model-produced review comments. Node-only.

import { matchesAnyGlob } from '../review-tools';
import type {
  ReviewComment,
  ReviewCommentStage,
  ReviewFile,
  ReviewRuleConfig,
  ReviewSeverity,
} from '../types';

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
  const newLine = typeof c.newLine === 'number' && c.newLine > 0 ? Math.floor(c.newLine) : null;
  const oldLine = typeof c.oldLine === 'number' && c.oldLine > 0 ? Math.floor(c.oldLine) : null;
  const line = typeof c.line === 'number' && c.line > 0 ? Math.floor(c.line) : null;
  return {
    id,
    filePath,
    oldLine,
    newLine: newLine ?? (oldLine === null ? line : null),
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
  const out: ReviewComment[] = [];
  for (const item of container) {
    const c = validateComment(item, known, rule, `c${out.length + 1}`, 'parsed');
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
  const out: ReviewComment[] = [];
  for (const obj of scanJsonObjects(text)) {
    const c = validateComment(obj, known, rule, `p${out.length + 1}`, 'pending');
    if (c) out.push(c);
  }
  return rule.maxComments > 0 ? out.slice(0, rule.maxComments) : out;
}
