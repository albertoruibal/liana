// Vite dev-server plugin: exposes git operations as JSON API under /api/*.
// The browser UI never links native git bindings; it talks to this plugin.
// Runs only under `vite dev`; production builds are static — start `npm run dev`.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Connect, Plugin, ViteDevServer } from 'vite';
import type { BranchInfo, GitCommit, RepoState, RepoStatus, StatusEntry } from './src/types';

const UNIT = '\x1f';

export class GitError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
  ) {
    super(message);
  }
}

export function gitRun(repoPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: repoPath,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' },
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
      commit.refs.push('HEAD');
    } else if (item.startsWith('HEAD -> ')) {
      commit.refs.push('HEAD');
      commit.refs.push(item.slice('HEAD -> '.length));
    } else if (item.startsWith('tag: ')) {
      commit.refs.push(item.slice('tag: '.length));
    } else {
      commit.refs.push(item.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\//, 'origin/'));
    }
  }
}

async function loadLog(repoPath: string, limit: number): Promise<GitCommit[]> {
  const fmt = ['%H', '%P', '%an', '%at', '%s', '%D'].join(UNIT);
  const out = await gitRun(repoPath, [
    'log',
    '--all',
    '--date-order',
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
      name: refname.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\//, 'origin/'),
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
    const code = line.slice(0, 2);
    const p = line.slice(3);
    if (!p) continue;
    entries.push({
      code: code === '??' ? '??' : (code[1] !== ' ' && code[1] !== '?' ? code[1] : code[0]) ?? '?',
      path: p,
      staged: code[0] !== ' ' && code !== '??',
    });
  }
  return { entries };
}

async function commitAll(repoPath: string, message: string): Promise<string> {
  await gitRun(repoPath, ['add', '-A']);
  await gitRun(repoPath, ['commit', '-m', message]);
  return (await gitRun(repoPath, ['rev-parse', 'HEAD'])).trim();
}

async function rebaseOnto(repoPath: string, onto: string): Promise<string> {
  const out = await gitRun(repoPath, ['rebase', onto]);
  return out.trim();
}

async function cherryPick(repoPath: string, ref: string): Promise<string> {
  const out = await gitRun(repoPath, ['cherry-pick', ref]);
  return out.trim();
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
              const { message } = JSON.parse(await readBody(req)) as { message?: string };
              if (!message?.trim()) return sendJson(res, 400, { error: 'Empty commit message' });
              const hash = await commitAll(repoPath, message.trim());
              return sendJson(res, 200, { ok: true, hash });
            }
            if (route === '/rebase' && req.method === 'POST') {
              const { onto } = JSON.parse(await readBody(req)) as { onto?: string };
              if (!onto?.trim()) return sendJson(res, 400, { error: 'Missing branch' });
              const out = await rebaseOnto(repoPath, onto.trim());
              return sendJson(res, 200, { ok: true, output: out });
            }
            if (route === '/cherry-pick' && req.method === 'POST') {
              const { ref } = JSON.parse(await readBody(req)) as { ref?: string };
              if (!ref?.trim()) return sendJson(res, 400, { error: 'Missing ref' });
              const out = await cherryPick(repoPath, ref.trim());
              return sendJson(res, 200, { ok: true, output: out });
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