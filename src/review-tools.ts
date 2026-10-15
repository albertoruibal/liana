// Read-only repository tools for the LLM review harness. The agent drives them
// through the OpenAI-compatible native function-calling API (`tools` /
// `tool_calls`). Node-only: imported by src/review.ts, never by the browser.
//
// Every tool is confined to the repository and reads at a ref (the MR head SHA
// by default) — never the local working tree or index. Output is truncated and
// paths are resolved inside the repo; the tools never write anything.

import { spawn } from 'node:child_process';
import path from 'node:path';

/** One tool the model may call. */
export interface ToolDef {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

/** A single tool invocation parsed from a model response. */
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** A chat message in the agent conversation. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Set on `tool` messages for native providers. */
  toolCallId?: string;
  /** Set on `assistant` messages that requested tools (native). */
  toolCalls?: ToolCall[];
}

/** Repository context the tools operate against. */
export interface ToolContext {
  repoPath: string;
  /** Ref the tools read (the MR head SHA). */
  headRef: string;
  /** Per-result character cap. */
  toolResultChars: number;
}

/** The read-only tool catalogue, described with JSON schema. */
export const TOOLS: ToolDef[] = [
  {
    name: 'list_files',
    description:
      'List repository files at a ref (the merge request head by default), optionally ' +
      'filtered by a glob pattern. Covers the whole repository, including files not in the diff.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob like "src/**/*.ts". Empty lists everything.' },
        ref: { type: 'string', description: 'Git ref; defaults to the merge request head.' },
      },
      required: [],
    },
  },
  {
    name: 'read_file',
    description:
      'Read a text file at a ref (the merge request head by default), optionally a line ' +
      'range (1-based, inclusive). Use this to verify facts in files outside the diff.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repository-relative path.' },
        ref: { type: 'string', description: 'Git ref; defaults to the merge request head.' },
        startLine: { type: 'integer', description: 'First line to return (1-based).' },
        endLine: { type: 'integer', description: 'Last line to return (inclusive).' },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_code',
    description:
      'Search tracked file contents at a ref (the merge request head by default), ' +
      'returning matching lines (ripgrep-like). Searches the whole repository, including ' +
      'files not in the diff, so related code can be verified. ' +
      'Supports extended regex, case-insensitive, whole-word, fixed-string, context lines, and filenames-only modes.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression to search for.' },
        glob: { type: 'string', description: 'Optional pathspec/glob to limit the search.' },
        ref: { type: 'string', description: 'Git ref; defaults to the merge request head.' },
        ignoreCase: { type: 'boolean', description: 'Case-insensitive match.' },
        fixedStrings: { type: 'boolean', description: 'Treat the pattern as a literal string.' },
        word: { type: 'boolean', description: 'Match whole words only.' },
        context: { type: 'integer', description: 'Lines of context before and after each match (0–10).' },
        filesOnly: { type: 'boolean', description: 'Return only the names of matching files.' },
        maxResults: { type: 'integer', description: 'Maximum matching lines to return (default 200).' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'git_log',
    description: 'Recent commit history, optionally limited to a path.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Limit history to this path.' },
        ref: { type: 'string', description: 'Git ref; defaults to the merge request head.' },
        max: { type: 'integer', description: 'Maximum commits (default 20).' },
      },
      required: [],
    },
  },
  {
    name: 'show_commit',
    description: 'Show a commit message, metadata, and changed files.',
    parameters: {
      type: 'object',
      properties: {
        sha: { type: 'string', description: 'Commit SHA or ref.' },
      },
      required: ['sha'],
    },
  },
  {
    name: 'add_comment',
    description:
      'Report one review comment. Call this as soon as you can substantiate an issue, then ' +
      'keep reviewing — do not wait until the end and never write comments in a final message. ' +
      'The comment is only proposed for the user to approve; it posts nothing. Use a line that ' +
      'appears in the diff, or omit the anchor for a comment about the file as a whole. ' +
      'Finish the batch separately with finish_batch.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Repository-relative path of a changed file.' },
        body: { type: 'string', description: 'The comment text.' },
        severity: {
          type: 'string',
          enum: ['info', 'warning', 'error'],
          description: 'How serious the issue is (default info).',
        },
        newLine: { type: 'integer', description: '1-based new-side line present in the diff.' },
        oldLine: { type: 'integer', description: '1-based old-side line present in the diff.' },
      },
      required: ['filePath', 'body'],
    },
  },
  {
    name: 'finish_batch',
    description:
      'Finish this batch of the review. Call this once you have covered the diff and have ' +
      'nothing further to report or inspect; it ends the batch. Report issues with ' +
      'add_comment, not here.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

// --- process helpers ---

/** Run a git command read-only; rejects with stderr on nonzero exit. */
function runGit(repoPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: repoPath,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => reject(new Error(`git failed to start: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `git ${args[0]} exited ${code}`));
    });
  });
}

/** Resolve a repo-relative path, rejecting traversal outside the repository. */
function safeRepoPath(repoPath: string, rel: string): string {
  const cleaned = rel.replace(/^\/+/, '');
  const abs = path.resolve(repoPath, cleaned);
  const root = path.resolve(repoPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`path outside repository: ${rel}`);
  }
  return cleaned;
}

/** Convert a shell-style glob to a RegExp anchored across the whole path. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === undefined) {
      break;
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/** Whether `filePath` matches any of the ignore globs. */
export function matchesAnyGlob(filePath: string, globs: string[]): boolean {
  return globs.some((g) => {
    try {
      return globToRegExp(g).test(filePath);
    } catch {
      return false;
    }
  });
}

/** Cut `text` to `max` characters, noting the truncation. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`;
}

// --- tool dispatch ---

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) ? v : undefined;
}

function asBool(v: unknown): boolean {
  return v === true;
}

/** Execute one tool call and return a truncated text result. */
export async function executeTool(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const raw = await runTool(ctx, name, args);
  return truncate(raw, ctx.toolResultChars);
}

async function runTool(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const ref = asString(args.ref) ?? ctx.headRef;
  switch (name) {
    case 'list_files': {
      const pattern = asString(args.pattern);
      const out = await runGit(ctx.repoPath, ['ls-tree', '-r', '--name-only', ref]);
      const files = out.split('\n').filter(Boolean);
      if (!pattern) return files.join('\n') || '(no files)';
      const re = globToRegExp(pattern);
      const matched = files.filter((f) => re.test(f));
      return matched.join('\n') || `(no files match ${pattern})`;
    }
    case 'read_file': {
      const rel = safeRepoPath(ctx.repoPath, asString(args.path) ?? '');
      const out = await runGit(ctx.repoPath, ['show', `${ref}:${rel}`]);
      const start = asInt(args.startLine);
      const end = asInt(args.endLine);
      if (start === undefined && end === undefined) return out;
      const lines = out.split('\n');
      const from = Math.max(1, start ?? 1);
      const to = end !== undefined ? Math.min(lines.length, end) : lines.length;
      return lines
        .slice(from - 1, to)
        .map((l, i) => `${from + i}: ${l}`)
        .join('\n');
    }
    case 'search_code': {
      const pattern = asString(args.pattern) ?? '';
      const glob = asString(args.glob);
      const filesOnly = asBool(args.filesOnly);
      const argv = ['grep', '-I'];
      if (asBool(args.ignoreCase)) argv.push('-i');
      if (asBool(args.word)) argv.push('-w');
      argv.push(asBool(args.fixedStrings) ? '-F' : '-E');
      const context = asInt(args.context);
      if (context !== undefined && context > 0) {
        argv.push('-C', String(Math.min(context, 10)));
      }
      argv.push(filesOnly ? '-l' : '-n');
      argv.push('-e', pattern, ref);
      if (glob) argv.push('--', glob);
      try {
        const out = await runGit(ctx.repoPath, argv);
        const lines = out.endsWith('\n') ? out.slice(0, -1).split('\n') : out.split('\n');
        const max = filesOnly ? 1000 : Math.max(1, Math.min(asInt(args.maxResults) ?? 200, 1000));
        if (lines.length <= max) return lines.join('\n');
        return `${lines.slice(0, max).join('\n')}\n… [${lines.length - max} more matches]`;
      } catch {
        return `(no matches for ${pattern})`;
      }
    }
    case 'git_log': {
      const max = asInt(args.max) ?? 20;
      const rel = asString(args.path);
      const argv = [
        'log',
        '-n',
        String(Math.max(1, Math.min(max, 100))),
        '--date=short',
        '--format=%h %ad %an%x09%s',
        ref,
      ];
      if (rel) argv.push('--', safeRepoPath(ctx.repoPath, rel));
      try {
        return await runGit(ctx.repoPath, argv);
      } catch {
        return '(no history)';
      }
    }
    case 'show_commit': {
      const sha = asString(args.sha) ?? '';
      try {
        return await runGit(ctx.repoPath, ['show', '--stat', '--format=fuller', sha]);
      } catch {
        return `(commit ${sha} not found)`;
      }
    }
    default:
      return `(unknown tool: ${name})`;
  }
}

// --- context budgeting ---

/**
 * Rough token estimate plus per-message overhead. Code and diffs tokenize
 * denser than prose (~2.5–3 chars/token on real tokenizers), so the divisor is
 * conservative (3.5 instead of 4) to keep the estimated prompt under the
 * model's actual context window rather than trusting an optimistic average.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5) + 4;
}

/**
 * Total estimated tokens for a message list. Counts assistant tool-call
 * arguments too — they travel on the wire but are not part of `content`, so a
 * content-only sum under-counts any turn that carries tool calls.
 */
export function messagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => {
    const args = m.toolCalls?.map((c) => JSON.stringify(c)).join('') ?? '';
    return sum + estimateTokens(m.content + args);
  }, 0);
}

/** One-line summary of a tool result for the trace panel. */
export function summarizeResult(result: string): string {
  const first = result.split('\n').find((l) => l.trim().length > 0) ?? '';
  return truncate(first.trim(), 120);
}

