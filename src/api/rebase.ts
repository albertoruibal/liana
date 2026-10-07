// Interactive rebase: todo planning and a non-interactive execution driver.
// Node-only. Mirrored by src/git/rebase.ts.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitRun, GitError, UNIT } from './exec';
import type { RebaseAction, RebaseTodoItem } from '../types';

export interface RebasePlan {
  /** Resolved commit hash of the rebase base. */
  onto: string;
  /** Commits to replay, oldest first (onto..HEAD). */
  items: Array<Omit<RebaseTodoItem, 'action' | 'message'>>;
}

async function resolveCommit(repoPath: string, ref: string): Promise<string> {
  return (await gitRun(repoPath, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
}

/** Commits between `onto` and HEAD, oldest first, that an interactive rebase would replay. */
export async function loadRebasePlan(repoPath: string, onto: string): Promise<RebasePlan> {
  const ontoHash = await resolveCommit(repoPath, onto);
  const fmt = ['%H', '%s', '%an', '%at'].join(UNIT);
  const out = await gitRun(repoPath, [
    'log',
    '--reverse',
    `--pretty=format:${fmt}`,
    `${ontoHash}..HEAD`,
  ]);
  const items: RebasePlan['items'] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [hash = '', subject = '', author = '', ts = ''] = line.split(UNIT);
    items.push({ hash, subject, author, timestamp: Number(ts) || 0 });
  }
  return { onto: ontoHash, items };
}

const REBASE_ACTIONS: readonly RebaseAction[] = ['pick', 'drop', 'reword', 'squash'];

/**
 * Run an interactive rebase from a generated todo list, without opening an editor.
 * Deterministic by construction:
 * - `reword` / `squash` are emitted as `fixup` + `exec git commit --amend -F <msgfile>`,
 *   so the replacement message is applied with no GIT_EDITOR interaction.
 * - a generated `sequence.editor` script writes the todo file.
 */
export async function executeRebase(
  repoPath: string,
  onto: string,
  items: RebaseTodoItem[],
): Promise<string> {
  const plan = await loadRebasePlan(repoPath, onto);
  const known = new Set(plan.items.map((i) => i.hash));
  if (items.length === 0) throw new GitError('Empty rebase todo', 'Nothing to rebase');

  // Resolve abbreviated hashes the UI may send to their full form.
  const resolved: RebaseTodoItem[] = [];
  for (const item of items) {
    try {
      resolved.push({ ...item, hash: await resolveCommit(repoPath, item.hash) });
    } catch {
      throw new GitError(`Unknown commit ${item.hash}`, 'Commit is not in the rebase range');
    }
  }
  items = resolved;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liana-rebase-'));
  try {
    const todoLines: string[] = [];
    // `squash`/`fixup`-style actions fold into the previous kept commit.
    let haveKept = false;
    items.forEach((item, idx) => {
      if (!known.has(item.hash)) {
        throw new GitError(`Unknown commit ${item.hash}`, 'Commit is not in the rebase range');
      }
      if (!REBASE_ACTIONS.includes(item.action)) {
        throw new GitError(`Bad action ${item.action}`, 'Unknown rebase action');
      }
      if (item.action === 'drop') {
        todoLines.push(`drop ${item.hash}`);
        return;
      }
      if ((item.action === 'reword' || item.action === 'squash') && !item.message?.trim()) {
        throw new GitError('Missing message', `${item.action} needs a message`);
      }
      if (item.action === 'squash' && !haveKept) {
        throw new GitError('Cannot squash first commit', 'Nothing to squash into');
      }

      if (item.action === 'squash') {
        todoLines.push(`fixup ${item.hash}`);
      } else {
        todoLines.push(`pick ${item.hash}`);
        haveKept = true;
      }

      if (item.action === 'reword' || item.action === 'squash') {
        const msgPath = path.join(dir, `msg-${idx}`);
        fs.writeFileSync(msgPath, `${item.message!.trim()}\n`);
        todoLines.push(`exec git commit --amend -F '${msgPath}'`);
      }
    });

    const seqEditor = path.join(dir, 'seq-editor.sh');
    const body = todoLines.join('\n');
    fs.writeFileSync(
      seqEditor,
      `#!/bin/sh\ncat > "$1" <<'LIANA_TODO_EOF'\n${body}\nLIANA_TODO_EOF\n`,
      { mode: 0o755 },
    );

    return (
      await gitRun(repoPath, ['-c', 'core.editor=true', 'rebase', '-i', plan.onto], {
        GIT_SEQUENCE_EDITOR: seqEditor,
      })
    ).trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
