// Submodule reads and the sanctioned network actions. Node-only.
// Mirrored by src/git/submodules.ts.

import fs from 'node:fs';
import path from 'node:path';
import { gitRun, GitError, NET_ENV } from './exec';
import { loadLog } from './repo';
import type { GitCommit, SubmoduleInfo } from '../types';

/** Parse `.gitmodules` (`git config -f .gitmodules --get-regexp`) into per-name fields. */
function parseGitmodules(out: string): Map<string, { path?: string; url?: string; branch?: string }> {
  const mods = new Map<string, { path?: string; url?: string; branch?: string }>();
  for (const line of out.split('\n')) {
    const m = /^submodule\.(.+?)\.(path|url|branch)\s+(.*)$/.exec(line.trim());
    if (!m) continue;
    const name = m[1] ?? '';
    const key = m[2] as 'path' | 'url' | 'branch';
    const mod = mods.get(name) ?? {};
    mod[key] = m[3] ?? '';
    mods.set(name, mod);
  }
  return mods;
}

/** Configured submodules with their checked-out state (`git submodule status`). */
export async function loadSubmodules(repoPath: string): Promise<SubmoduleInfo[]> {
  const cfgOut = await gitRun(repoPath, ['config', '-f', '.gitmodules', '--get-regexp', '.']).catch(() => '');
  const mods = parseGitmodules(cfgOut);
  const statusOut = await gitRun(repoPath, ['submodule', 'status', '--recursive']).catch(() => '');
  const byPath = new Map<string, SubmoduleInfo>();
  for (const [name, mod] of mods) {
    if (!mod.path) continue;
    byPath.set(mod.path, {
      name,
      path: mod.path,
      url: mod.url ?? '',
      branch: mod.branch ?? null,
      recordedHash: null,
      worktreeHash: null,
      status: 'uninitialized',
    });
  }
  for (const raw of statusOut.split('\n')) {
    if (!raw.trim()) continue;
    const prefix = raw[0] ?? ' ';
    const rest = raw.slice(1);
    const m = /^([0-9a-f]{7,64})\s+(\S+)/.exec(rest);
    if (!m) continue;
    const hash = m[1] ?? '';
    const subPath = m[2] ?? '';
    const entry = byPath.get(subPath) ?? {
      name: subPath,
      path: subPath,
      url: '',
      branch: null,
      recordedHash: null,
      worktreeHash: null,
      status: 'untracked' as const,
    };
    if (prefix === '-') {
      entry.recordedHash = hash;
      entry.worktreeHash = null;
      entry.status = 'uninitialized';
    } else {
      entry.worktreeHash = hash;
      entry.status = prefix === '+' ? 'modified' : prefix === 'U' ? 'conflicted' : 'current';
    }
    byPath.set(subPath, entry);
  }
  for (const entry of byPath.values()) {
    if (entry.recordedHash === null) {
      // Recorded commit id lives in the superproject's index for the gitlink.
      try {
        const out = (await gitRun(repoPath, ['ls-files', '--stage', '--', entry.path])).trim();
        const m = /^\d+\s+([0-9a-f]+)/.exec(out);
        entry.recordedHash = m?.[1] ?? null;
      } catch {
        entry.recordedHash = null;
      }
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** Run a network submodule command with the same no-prompt environment as push/pull. */
async function submoduleNetwork(repoPath: string, args: string[]): Promise<string> {
  return (await gitRun(repoPath, ['submodule', ...args], NET_ENV)).trim();
}

/** `git submodule update`; `--init` initializes, `--remote` tracks the remote branch. */
export async function submoduleUpdate(
  repoPath: string,
  opts: { remote?: boolean; init?: boolean } = {},
): Promise<string> {
  const args = ['update'];
  if (opts.init) args.push('--init');
  if (opts.remote) args.push('--remote');
  return submoduleNetwork(repoPath, args);
}

/** `git submodule sync --recursive`: update the submodule URLs from `.gitmodules`. */
export async function submoduleSync(repoPath: string): Promise<string> {
  return submoduleNetwork(repoPath, ['sync', '--recursive']);
}

/** `git submodule add`: clone `url` into `path` (defaults to a derived directory). */
export async function submoduleAdd(
  repoPath: string,
  url: string,
  dest?: string,
  branch?: string,
): Promise<string> {
  const args = ['add', '-q'];
  if (branch?.trim()) args.push('-b', branch.trim());
  args.push(url);
  if (dest?.trim()) args.push(dest.trim());
  return submoduleNetwork(repoPath, args);
}

/** `git submodule deinit <path>`: unregister a submodule and clear its work tree. */
export async function submoduleDeinit(repoPath: string, dest: string, force = false): Promise<string> {
  const args = ['deinit'];
  if (force) args.push('-f');
  args.push('--', dest);
  return (await gitRun(repoPath, ['submodule', ...args])).trim();
}

/**
 * History of a submodule, read by running the graph's `git log` inside the
 * submodule's own repository. `subPath` is resolved under `repoPath` and must not
 * escape it.
 */
export async function loadSubmoduleLog(
  repoPath: string,
  subPath: string,
  limit = 300,
): Promise<GitCommit[]> {
  const abs = path.resolve(repoPath, subPath);
  const root = path.resolve(repoPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new GitError(`Invalid submodule path: ${subPath}`, 'Path is outside the repository', 400);
  }
  if (!fs.existsSync(abs)) {
    throw new GitError(`Submodule not initialized: ${subPath}`, 'Run submodule update first', 400);
  }
  return loadLog(abs, limit);
}
