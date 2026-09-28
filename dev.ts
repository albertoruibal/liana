// Vite dev-server plugin: exposes git operations as JSON API under /api/*.
// The browser UI never links native git bindings; it talks to this plugin.
// Runs only under `vite dev`; production builds are static — start `npm run dev`.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Connect, Plugin, ViteDevServer } from 'vite';
import { INTERACTIVE_REBASE_ENABLED } from './src/config';
import type {
  BranchInfo,
  GitCommit,
  RebaseAction,
  RebaseTodoItem,
  RepoState,
  RepoStatus,
  StatusEntry,
} from './src/types';

const UNIT = '\x1f';

export class GitError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
  ) {
    super(message);
  }
}

export function gitRun(
  repoPath: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: repoPath,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C', ...extraEnv },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => reject(new GitError(`git failed to start: ${err.message}`, stderr)));
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new GitError(`git ${args[0]} failed (exit ${code})`, stderr.trim()));
    });
  });
}

function parseDecorations(decorated: string, commit: GitCommit): void {
  if (!decorated.trim()) return;
  for (const item of decorated.split(', ').map((s) => s.trim())) {
    if (item === 'HEAD') {
      commit.refs.push({ name: 'HEAD', kind: 'head' });
    } else if (item.startsWith('HEAD -> ')) {
      commit.refs.push({ name: 'HEAD', kind: 'head' });
      const target = item.slice('HEAD -> '.length);
      commit.refs.push({ name: target.replace(/^refs\/heads\//, ''), kind: 'local' });
    } else if (item.startsWith('tag: ')) {
      commit.refs.push({ name: item.slice('tag: '.length).replace(/^refs\/tags\//, ''), kind: 'tag' });
    } else if (item.startsWith('refs/remotes/')) {
      commit.refs.push({ name: item.slice('refs/remotes/'.length), kind: 'remote' });
    } else if (item.startsWith('refs/heads/')) {
      commit.refs.push({ name: item.slice('refs/heads/'.length), kind: 'local' });
    } else {
      // Short %D falls back to the default remote as "origin/...".
      commit.refs.push({ name: item, kind: item.startsWith('origin/') ? 'remote' : 'local' });
    }
  }
}

async function loadLog(repoPath: string, limit: number): Promise<GitCommit[]> {
  const fmt = ['%H', '%P', '%an', '%at', '%s', '%D'].join(UNIT);
  const out = await gitRun(repoPath, [
    'log',
    '--all',
    '--date-order',
    '--decorate=full',
    `--pretty=format:${fmt}`,
    `--max-count=${limit}`,
  ]);
  const commits: GitCommit[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [hash = '', parents = '', author = '', ts = '', subject = '', decorated = ''] =
      line.split(UNIT);
    const commit: GitCommit = {
      hash,
      parents: parents ? parents.split(' ') : [],
      author,
      timestamp: Number(ts) || 0,
      subject,
      refs: [],
    };
    parseDecorations(decorated, commit);
    commits.push(commit);
  }
  return commits;
}

async function loadRepoState(repoPath: string): Promise<RepoState> {
  const headOut = await gitRun(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const symbolic = (
    await gitRun(repoPath, ['rev-parse', '--symbolic-full-name', 'HEAD']).catch(() => '')
  ).trim();
  const branchOut = await gitRun(repoPath, ['for-each-ref', '--format=%(refname)%00%(objectname)']);
  const detachedHead = !symbolic.startsWith('refs/heads/');
  const headBranch = detachedHead ? null : symbolic.replace(/^refs\/heads\//, '');

  const branches: BranchInfo[] = [];
  for (const line of branchOut.split('\n')) {
    if (!line.trim()) continue;
    const [refname = '', hash = ''] = line.split('\x00');
    if (!refname.startsWith('refs/heads/') && !refname.startsWith('refs/remotes/')) continue;
    branches.push({
      name: refname.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\//, ''),
      hash,
      isHead: !detachedHead && refname === `refs/heads/${headBranch}`,
      isRemote: refname.startsWith('refs/remotes/'),
    });
  }

  const name = path.basename(repoPath);
  return { name, headBranch, detachedHead, branches };
}

async function loadStatus(repoPath: string): Promise<RepoStatus> {
  const out = await gitRun(repoPath, ['status', '--porcelain=v1', '--untracked-files=all']);
  const entries: StatusEntry[] = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const xy = line.slice(0, 2);
    const p = line.slice(3);
    if (!p) continue;
    entries.push({ stagedX: xy[0] ?? ' ', unstagedY: xy[1] ?? ' ', path: p });
  }
  return { entries };
}

/** Number of uncommitted (staged or unstaged) entries in the working tree. */
async function dirtyCount(repoPath: string): Promise<number> {
  return (await loadStatus(repoPath)).entries.length;
}

/** Guard for operations git refuses to run on a dirty tree; returns an error string or null. */
async function dirtyGuard(repoPath: string, op: string): Promise<string | null> {
  const n = await dirtyCount(repoPath);
  if (n === 0) return null;
  const changes = n === 1 ? 'change' : 'changes';
  return `${n} uncommitted ${changes} — commit or stash before ${op}`;
}

async function createCommit(repoPath: string, message: string, stageAll: boolean): Promise<string> {
  if (stageAll) await gitRun(repoPath, ['add', '-A']);
  await gitRun(repoPath, ['commit', '-m', message]);
  return (await gitRun(repoPath, ['rev-parse', 'HEAD'])).trim();
}

async function rebaseOnto(repoPath: string, onto: string): Promise<string> {
  const out = await gitRun(repoPath, ['rebase', onto]);
  return out.trim();
}

async function cherryPick(
  repoPath: string,
  ref: string,
  opts: { mainline?: number; record?: boolean } = {},
): Promise<string> {
  const args = ['cherry-pick'];
  if (opts.record) args.push('-x');
  if (opts.mainline !== undefined) args.push('-m', String(opts.mainline));
  args.push(ref);
  const out = await gitRun(repoPath, args);
  return out.trim();
}

/** `git show --stat` for a single commit, as text. */
async function commitDiffStat(repoPath: string, hash: string): Promise<string> {
  return (await gitRun(repoPath, ['show', '--stat', '--format=%h %s (%an)', hash])).trim();
}

// --- Interactive rebase (Phase 5) ---

interface RebasePlan {
  /** Resolved commit hash of the rebase base. */
  onto: string;
  /** Commits to replay, oldest first (onto..HEAD). */
  items: Array<Omit<RebaseTodoItem, 'action' | 'message'>>;
}

async function resolveCommit(repoPath: string, ref: string): Promise<string> {
  return (await gitRun(repoPath, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
}

/** Commits between `onto` and HEAD, oldest first, that an interactive rebase would replay. */
async function loadRebasePlan(repoPath: string, onto: string): Promise<RebasePlan> {
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
async function executeRebase(repoPath: string, onto: string, items: RebaseTodoItem[]): Promise<string> {
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

// --- HTTP plumbing ---

function sendJson(res: Connect.IncomingMessage, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

async function readBody(req: Connect.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function resolveOpenRepo(body: string): Promise<string | null> {
  let raw = '';
  try {
    const parsed = JSON.parse(body) as { path?: string };
    raw = typeof parsed.path === 'string' ? parsed.path : '';
  } catch {
    return null;
  }
  if (!raw.trim()) return null;
  const expanded = raw.startsWith('~') ? path.join(process.env.HOME ?? '', raw.slice(1)) : raw;
  const abs = path.resolve(expanded);
  try {
    const st = fs.statSync(abs);
    if (!st.isDirectory()) return null;
  } catch {
    return null;
  }
  try {
    await gitRun(abs, ['rev-parse', '--git-dir']);
  } catch {
    return null;
  }
  return abs;
}

export function apiPlugin(defaultRepo: string | null): Plugin {
  return {
    name: 'liana-api',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      let repoPath = defaultRepo ?? '';

      server.middlewares.use('/api', (req, res, next) => {
        const route = (req.url ?? '').split('?')[0]!;
        void (async (): Promise<void> => {
          try {
            if (route === '/state' && req.method === 'GET') {
              if (!repoPath) return sendJson(res, 200, { configured: false });
              const [state, log, status] = await Promise.all([
                loadRepoState(repoPath),
                loadLog(repoPath, 500),
                loadStatus(repoPath).catch(() => ({ entries: [] as StatusEntry[] })),
              ]);
              return sendJson(res, 200, {
                configured: true,
                repoPath,
                state,
                commits: log,
                status,
              });
            }
            if (route === '/open' && req.method === 'POST') {
              const abs = await resolveOpenRepo(await readBody(req));
              if (!abs) return sendJson(res, 400, { error: 'Not a git repository' });
              repoPath = abs;
              return sendJson(res, 200, { ok: true, repoPath });
            }
            if (!repoPath) return sendJson(res, 400, { error: 'No repository open' });

            if (route === '/commit' && req.method === 'POST') {
              const { message, stageAll } = JSON.parse(await readBody(req)) as {
                message?: string;
                stageAll?: boolean;
              };
              if (!message?.trim()) return sendJson(res, 400, { error: 'Empty commit message' });
              const hash = await createCommit(repoPath, message.trim(), stageAll !== false);
              return sendJson(res, 200, { ok: true, hash });
            }
            if (route === '/rebase' && req.method === 'POST') {
              const { onto } = JSON.parse(await readBody(req)) as { onto?: string };
              if (!onto?.trim()) return sendJson(res, 400, { error: 'Missing branch' });
              const dirty = await dirtyGuard(repoPath, 'rebasing');
              if (dirty) return sendJson(res, 409, { error: dirty });
              const out = await rebaseOnto(repoPath, onto.trim());
              return sendJson(res, 200, { ok: true, output: out });
            }
            if (route === '/rebase-start' && req.method === 'POST') {
              if (!INTERACTIVE_REBASE_ENABLED) {
                return sendJson(res, 404, { error: 'Interactive rebase disabled' });
              }
              const { onto } = JSON.parse(await readBody(req)) as { onto?: string };
              if (!onto?.trim()) return sendJson(res, 400, { error: 'Missing branch' });
              const dirty = await dirtyGuard(repoPath, 'rebasing');
              if (dirty) return sendJson(res, 409, { error: dirty });
              const plan = await loadRebasePlan(repoPath, onto.trim());
              return sendJson(res, 200, { ok: true, onto: plan.onto, items: plan.items });
            }
            if (route === '/rebase-execute' && req.method === 'POST') {
              if (!INTERACTIVE_REBASE_ENABLED) {
                return sendJson(res, 404, { error: 'Interactive rebase disabled' });
              }
              const { onto, items } = JSON.parse(await readBody(req)) as {
                onto?: string;
                items?: RebaseTodoItem[];
              };
              if (!onto?.trim()) return sendJson(res, 400, { error: 'Missing branch' });
              if (!Array.isArray(items) || items.length === 0) {
                return sendJson(res, 400, { error: 'Empty rebase todo' });
              }
              const dirty = await dirtyGuard(repoPath, 'rebasing');
              if (dirty) return sendJson(res, 409, { error: dirty });
              const out = await executeRebase(repoPath, onto.trim(), items);
              return sendJson(res, 200, { ok: true, output: out });
            }
            if (route === '/cherry-pick' && req.method === 'POST') {
              const { ref, mainline, record } = JSON.parse(await readBody(req)) as {
                ref?: string;
                mainline?: number;
                record?: boolean;
              };
              if (!ref?.trim()) return sendJson(res, 400, { error: 'Missing ref' });
              if (mainline !== undefined && (!Number.isInteger(mainline) || mainline < 1)) {
                return sendJson(res, 400, { error: 'mainline must be a positive integer' });
              }
              const dirty = await dirtyGuard(repoPath, 'cherry-picking');
              if (dirty) return sendJson(res, 409, { error: dirty });
              const out = await cherryPick(repoPath, ref.trim(), { mainline, record });
              return sendJson(res, 200, { ok: true, output: out });
            }
            if (route === '/commit-diff' && req.method === 'POST') {
              const { hash } = JSON.parse(await readBody(req)) as { hash?: string };
              if (!hash?.trim()) return sendJson(res, 400, { error: 'Missing hash' });
              const stat = await commitDiffStat(repoPath, hash.trim());
              return sendJson(res, 200, { ok: true, stat });
            }
            if (route === '/checkout' && req.method === 'POST') {
              const { branch } = JSON.parse(await readBody(req)) as { branch?: string };
              if (!branch?.trim()) return sendJson(res, 400, { error: 'Missing branch' });
              await gitRun(repoPath, ['checkout', branch.trim()]);
              return sendJson(res, 200, { ok: true });
            }
            return sendJson(res, 404, { error: 'Unknown route' });
          } catch (err) {
            const message = err instanceof GitError ? err.stderr || err.message : String(err);
            return sendJson(res, 500, { error: message });
          }
        })();
      });
    },
  };
}