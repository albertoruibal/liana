// Repo-confined filesystem helpers. Node-only. Mirrored by src/git/paths.ts.

import fs from 'node:fs';
import path from 'node:path';

/** Resolve `filePath` beneath `repoPath`; null when the path escapes the repository. */
export function safeResolve(repoPath: string, filePath: string): string | null {
  const root = path.resolve(repoPath);
  const abs = path.resolve(root, filePath);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

/** Read a repo-relative working-tree file as UTF-8, or null when missing/unreadable. */
export function readRepoFile(repoPath: string, filePath: string): string | null {
  const abs = safeResolve(repoPath, filePath);
  if (!abs) return null;
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

/** Heuristic for binary stage content: a NUL byte in the first 8000 chars. */
export function looksBinary(text: string): boolean {
  return text.slice(0, 8000).includes('\0');
}
