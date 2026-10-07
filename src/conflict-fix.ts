// AI conflict resolution: ask an OpenAI-compatible model to merge the three
// index stages of one conflicted path, then apply the user-approved result to
// the working tree and stage it. Node-only (spawns git, reads settings) — like
// the review backend it must never be imported by the browser bundle.
//
// This is the one place Liana writes a merge result itself: it happens only for
// a per-file proposal the user has reviewed and explicitly applied, and it is
// always followed by `git add` so git's own state stays authoritative.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { activeProvider, providerById, type StoredProvider } from './settings';
import { completeText } from './review/index';
import type { AiConflictFix, ConflictFile } from './types';

// Reject rather than truncate: a file silently cut in half would produce a
// corrupt merge. Reserve room for the prompt, the reply, and the model's tokens.
const INPUT_BUDGET_RATIO = 0.6;

/**
 * Run a git command confined to `repoPath`, rejecting with stderr on failure.
 * Mirrors the read-only harness in review-tools.ts; kept local so this module
 * has no dependency on the review agent.
 */
function runGit(repoPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: repoPath,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `git ${args.join(' ')} exited ${code}`));
    });
  });
}

/** Resolve a repo-relative path, refusing anything that escapes the repository. */
function safeRepoPath(repoPath: string, rel: string): string {
  if (!rel || path.isAbsolute(rel)) throw new Error(`Invalid path: ${rel}`);
  const abs = path.resolve(repoPath, rel);
  const root = path.resolve(repoPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`Path escapes the repository: ${rel}`);
  return abs;
}

function providerFor(providerId?: string): StoredProvider {
  const provider = (providerId !== undefined ? providerById(providerId) : null) ?? activeProvider();
  if (!provider) throw new Error('No AI provider configured — add one in Settings');
  if (!provider.model.trim()) throw new Error('No model set for the active AI provider');
  return provider;
}

function stage(label: string, present: boolean, content: string | null): string {
  if (!present) return `### ${label} (this side deleted the file)\n`;
  if (content === null) return `### ${label} (unavailable)\n`;
  return `### ${label}\n${content}`;
}

const SYSTEM_PROMPT = [
  'You are a careful git merge-conflict resolver.',
  'You are given the base revision and the two conflicting sides of a single file.',
  'Produce a single merged file that preserves the intent of BOTH sides, resolving the conflict markers.',
  'Prefer minimal, faithful edits; do not reformat or rewrite unrelated code.',
  'Never include conflict markers (<<<<<<<, =======, >>>>>>>) in the result.',
].join(' ');

/** Extract the merged file from the model reply, tolerating fences. */
function stripFence(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  return fence?.[1] ?? trimmed;
}

function parseFix(raw: string, file: ConflictFile, model: string): AiConflictFix {
  const text = raw.replace(/\r\n/g, '\n');
  if (text.includes('<<<DELETE>>>')) {
    const explanation = text.split('<<<DELETE>>>')[0]?.trim() ?? '';
    return { path: file.path, kind: 'delete', content: null, explanation, model };
  }
  const marker = '<<<MERGED>>>';
  const idx = text.indexOf(marker);
  let explanation = '';
  let body: string;
  if (idx !== -1) {
    explanation = text.slice(0, idx).trim();
    body = text.slice(idx + marker.length);
  } else {
    // The model ignored the marker: fall back to a fenced block, else everything.
    const fence = text.match(/```[^\n]*\n([\s\S]*?)```/);
    body = fence?.[1] ?? text;
    explanation = fence ? text.replace(fence[0], '').trim() : '';
  }
  const content = stripFence(body);
  if (!content) throw new Error('The model returned an empty merge result');
  return { path: file.path, kind: 'content', content, explanation, model };
}

/**
 * Ask the configured model to merge one conflicted path. Throws with a clear
 * message when the conflict is binary/submodule or too large for the context.
 */
export async function proposeConflictFix(
  file: ConflictFile,
  providerId?: string,
  signal?: AbortSignal,
): Promise<AiConflictFix> {
  if (file.isSubmodule) throw new Error('Submodule conflicts cannot be merged with AI');
  if (file.isBinary) throw new Error('Binary conflicts cannot be merged with AI');
  const provider = providerFor(providerId);

  const base = stage('BASE', file.hasBase, file.base);
  const ours = stage('OURS', file.hasOurs, file.ours);
  const theirs = stage('THEIRS', file.hasTheirs, file.theirs);
  const user = [
    `File: ${file.path}`,
    `Conflict type: ${file.type}`,
    '',
    'Return a short explanation, then a line containing exactly <<<MERGED>>> followed by the full merged file.',
    'If both sides agree the file should not exist, return exactly <<<DELETE>>> instead (no merged file).',
    '',
    base,
    ours,
    theirs,
  ].join('\n');

  const budgetChars = Math.floor(provider.contextWindow * INPUT_BUDGET_RATIO) * 4;
  if (user.length > budgetChars) {
    throw new Error(
      `Conflict too large for the model's context (${user.length} chars > ${budgetChars}). Resolve it manually.`,
    );
  }

  const reply = await completeText(provider, SYSTEM_PROMPT, user, {
    maxTokens: provider.maxTokens,
    signal,
  });
  return parseFix(reply, file, provider.model);
}

/** True when `filePath` still has unmerged index entries. */
async function isUnmerged(repoPath: string, filePath: string): Promise<boolean> {
  const out = await runGit(repoPath, ['ls-files', '-u', '-z', '--', filePath]);
  return out.length > 0;
}

/**
 * Apply a reviewed merge result: write the content (or remove the file), then
 * stage it with `git add`. Refuses a path that is no longer conflicted.
 */
export async function applyConflictFix(
  repoPath: string,
  filePath: string,
  kind: 'content' | 'delete',
  content: string | null,
): Promise<void> {
  const rel = filePath.trim();
  if (!rel) throw new Error('Missing path');
  const abs = safeRepoPath(repoPath, rel);
  if (!(await isUnmerged(repoPath, rel))) {
    throw new Error(`Not a conflicted path (anymore): ${rel}`);
  }
  if (kind === 'delete') {
    // Remove any worktree copy, then stage the deletion to resolve the conflict.
    fs.rmSync(abs, { force: true });
    await runGit(repoPath, ['add', '-A', '--', rel]);
    return;
  }
  if (content === null) throw new Error('Missing merged content');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  await runGit(repoPath, ['add', '--', rel]);
}
