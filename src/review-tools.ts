// Read-only repository tools for the LLM review harness, plus the protocol
// adapters that let small local models drive them without native function
// calling. Node-only: imported by src/review.ts, never by the browser.
//
// Every tool is confined to the repository and reads at a ref (the MR head SHA
// by default) — never the local working tree or index. Output is truncated and
// paths are resolved inside the repo; the tools never write anything.

import { spawn } from 'node:child_process';
import path from 'node:path';
import type { GitLabMrFile, ToolProtocol } from './types';

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

/** Protocol-agnostic chat message handed to an adapter. */
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
  /** Changed files of the MR, for `get_mr_changes`. */
  files: GitLabMrFile[];
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
    name: 'git_blame',
    description: 'Blame a line range of a file, showing the commit and author per line.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repository-relative path.' },
        ref: { type: 'string', description: 'Git ref; defaults to the merge request head.' },
        startLine: { type: 'integer', description: 'First line (1-based).' },
        endLine: { type: 'integer', description: 'Last line (inclusive).' },
      },
      required: ['path'],
    },
  },
  {
    name: 'git_diff',
    description: 'Unified diff between two refs, optionally limited to a path.',
    parameters: {
      type: 'object',
      properties: {
        base: { type: 'string', description: 'Base ref.' },
        head: { type: 'string', description: 'Head ref.' },
        path: { type: 'string', description: 'Limit the diff to this path.' },
      },
      required: ['base', 'head'],
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
    name: 'get_mr_changes',
    description: 'List the changed files and their unified diffs for this merge request.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Optional path filter.' },
      },
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
    case 'git_blame': {
      const rel = safeRepoPath(ctx.repoPath, asString(args.path) ?? '');
      const start = Math.max(1, asInt(args.startLine) ?? 1);
      const end = asInt(args.endLine) ?? start + 200;
      try {
        return await runGit(ctx.repoPath, [
          'blame',
          '--date=short',
          '-L',
          `${start},${end}`,
          ref,
          '--',
          rel,
        ]);
      } catch {
        return '(blame unavailable)';
      }
    }
    case 'git_diff': {
      const base = asString(args.base) ?? '';
      const head = asString(args.head) ?? '';
      const rel = asString(args.path);
      const argv = ['diff', base, head];
      if (rel) argv.push('--', safeRepoPath(ctx.repoPath, rel));
      try {
        return await runGit(ctx.repoPath, argv);
      } catch {
        return '(diff unavailable)';
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
    case 'get_mr_changes': {
      const filter = asString(args.path);
      const parts: string[] = [];
      for (const f of ctx.files) {
        if (filter && f.newPath !== filter && f.oldPath !== filter) continue;
        const tags = [
          f.newFile ? 'new' : '',
          f.deletedFile ? 'deleted' : '',
          f.renamedFile ? 'renamed' : '',
        ]
          .filter(Boolean)
          .join(' ');
        parts.push(`### ${f.newPath}${tags ? ` (${tags})` : ''}\n${f.diff || '(binary or empty diff)'}`);
      }
      return parts.join('\n\n') || '(no changed files)';
    }
    default:
      return `(unknown tool: ${name})`;
  }
}

// --- context budgeting ---

/** Rough token estimate (~4 chars/token plus per-message overhead). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4) + 4;
}

/** Total estimated tokens for a message list. */
export function messagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
}

/** One-line summary of a tool result for the trace panel. */
export function summarizeResult(result: string): string {
  const first = result.split('\n').find((l) => l.trim().length > 0) ?? '';
  return truncate(first.trim(), 120);
}

// --- protocol adapters ---

/** A text protocol's request body and response parser. */
export interface ProtocolAdapter {
  name: Exclude<ToolProtocol, 'auto'>;
  /** Extra system-prompt guidance describing how to call tools. */
  guidance(tools: ToolDef[]): string;
  /** Whether the adapter passes native `tools` in the request body. */
  native: boolean;
  /** Parse an assistant message (and, for text protocols, any tool call). */
  parse(message: unknown): { content: string; toolCalls: ToolCall[] };
}

/** Render the tool catalogue as readable text for prompt-only protocols. */
function toolText(tools: ToolDef[]): string {
  return tools
    .map((t) => {
      const params = Object.entries(t.parameters.properties)
        .map(([k, v]) => {
          const desc = (v as { description?: string }).description ?? '';
          return `      ${k}: ${desc}`;
        })
        .join('\n');
      return `- ${t.name}: ${t.description}\n    parameters:\n${params || '      (none)'}`;
    })
    .join('\n');
}

let reactCounter = 0;

const nativeAdapter: ProtocolAdapter = {
  name: 'native',
  native: true,
  guidance: () => '',
  parse(message) {
    const m = (message ?? {}) as {
      content?: unknown;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    const toolCalls: ToolCall[] = [];
    for (const call of m.tool_calls ?? []) {
      const fn = call.function;
      if (!fn?.name) continue;
      let args: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(fn.arguments || '{}') as unknown;
        if (typeof parsed === 'object' && parsed !== null) args = parsed as Record<string, unknown>;
      } catch {
        args = {};
      }
      toolCalls.push({ id: call.id ?? `call_${reactCounter++}`, name: fn.name, args });
    }
    return { content: typeof m.content === 'string' ? m.content : '', toolCalls };
  },
};

const reactAdapter: ProtocolAdapter = {
  name: 'react',
  native: false,
  guidance(tools) {
    return (
      'You may inspect the repository with the tools below. To call one, reply with EXACTLY:\n' +
      'Thought: <brief reasoning>\n' +
      'Action: <tool name>\n' +
      'Action Input: <a single-line JSON object of arguments>\n' +
      'Then stop and wait for the Observation. When you have enough information, reply with\n' +
      'Thought: I have finished\n' +
      'Final Answer: <the JSON review result>\n\n' +
      `Available tools:\n${toolText(tools)}`
    );
  },
  parse(message) {
    const m = (message ?? {}) as { content?: unknown };
    const content = typeof m.content === 'string' ? m.content : '';
    const action = content.match(/Action:\s*(.+)/i)?.[1]?.trim();
    const inputRaw = content.match(/Action Input:\s*(.+)/i)?.[1]?.trim();
    if (!action || !/^[a-z_]+$/i.test(action)) return { content, toolCalls: [] };
    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(inputRaw ?? '{}') as unknown;
      if (typeof parsed === 'object' && parsed !== null) args = parsed as Record<string, unknown>;
    } catch {
      args = {};
    }
    return {
      content,
      toolCalls: [{ id: `react_${reactCounter++}`, name: action, args }],
    };
  },
};

const jsonAdapter: ProtocolAdapter = {
  name: 'json',
  native: false,
  guidance(tools) {
    return (
      'You inspect the repository by replying with a single JSON object and nothing else.\n' +
      'To call a tool: {"tool": "<name>", "args": { … }}.\n' +
      'When finished, reply with the review result: {"comments": [ … ]}.\n\n' +
      `Available tools:\n${toolText(tools)}`
    );
  },
  parse(message) {
    const m = (message ?? {}) as { content?: unknown };
    const content = typeof m.content === 'string' ? m.content : '';
    const obj = extractJsonObject(content);
    if (obj && typeof obj.tool === 'string') {
      const args = (typeof obj.args === 'object' && obj.args !== null
        ? obj.args
        : {}) as Record<string, unknown>;
      return { content, toolCalls: [{ id: `json_${reactCounter++}`, name: obj.tool, args }] };
    }
    return { content, toolCalls: [] };
  },
};

const noneAdapter: ProtocolAdapter = {
  name: 'none',
  native: false,
  guidance: () => 'Do not call tools. Review the provided changes directly.',
  parse(message) {
    const m = (message ?? {}) as { content?: unknown };
    return { content: typeof m.content === 'string' ? m.content : '', toolCalls: [] };
  },
};

/** Look up an adapter by negotiated/forced protocol. */
export function adapterFor(protocol: Exclude<ToolProtocol, 'auto'>): ProtocolAdapter {
  switch (protocol) {
    case 'native':
      return nativeAdapter;
    case 'react':
      return reactAdapter;
    case 'json':
      return jsonAdapter;
    case 'none':
      return noneAdapter;
  }
}

/**
 * Extract the first balanced JSON object from model text, tolerating code
 * fences and surrounding prose. Returns null when none parses.
 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (c === undefined) break;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(cleaned.slice(start, i + 1)) as unknown;
          return typeof parsed === 'object' && parsed !== null
            ? (parsed as Record<string, unknown>)
            : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}


