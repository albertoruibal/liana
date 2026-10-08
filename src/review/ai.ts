// OpenAI-compatible chat client: streaming and one-shot completions with
// AbortController timeouts and unchanged upstream-error passthrough. Node-only.

import { providerKey, type StoredProvider } from '../settings';
import type { ToolCall } from '../review-tools';

// The LLM call (including a streamed response) may take a long time on slow
// local models, so allow up to 12 hours. Forge requests stay short.
export const HTTP_TIMEOUT_MS = 12 * 60 * 60 * 1000;

/** Human-readable duration for timeout error messages. */
function formatTimeout(ms: number): string {
  const hours = ms / 3_600_000;
  if (Number.isInteger(hours)) return `${hours}h`;
  return `${Math.round(ms / 1000)}s`;
}

export interface CompletionResult {
  content: string;
  toolCalls: ToolCall[];
}

export interface ChatRequest {
  model: string;
  messages: unknown[];
  temperature: number;
  max_tokens: number;
  /** Request SSE streaming; an endpoint that ignores it still gets the JSON fallback. */
  stream?: boolean;
  tools?: unknown;
  tool_choice?: string;
}

/**
 * Call `/chat/completions`. Streamed text is appended to `onDelta` so a job can
 * show partial output; a server that ignores streaming still gets a plain JSON
 * response handled below.
 */
export async function chatCompletion(
  provider: StoredProvider,
  request: ChatRequest,
  onDelta?: (chunk: string) => void,
  signal?: AbortSignal,
  labels: { cancelled?: string; timeout?: string } = {},
): Promise<CompletionResult> {
  const key = providerKey(provider);
  const url = `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  // Abort the request promptly when the job is cancelled, not after the timeout.
  const onAbort = (): void => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      const err = new Error(`AI endpoint ${res.status}: ${text}`) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }

    // Some local servers ignore streaming and return a normal JSON body; only
    // treat the response as SSE when it actually says so.
    const contentType = res.headers.get('content-type') ?? '';
    if (res.body && contentType.includes('text/event-stream')) {
      return await readStream(res.body, onDelta);
    }
    const raw = (await res.json()) as unknown;
    return parseCompletion(raw);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      // Distinguish a user cancellation from hitting the timeout.
      if (signal?.aborted) throw new Error(labels.cancelled ?? 'Review cancelled');
      throw new Error(labels.timeout ?? `AI request timed out after ${formatTimeout(HTTP_TIMEOUT_MS)}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

interface StreamDelta {
  content?: string;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

/** Consume an OpenAI SSE stream, accumulating content and tool-call fragments. */
async function readStream(
  body: ReadableStream<Uint8Array>,
  onDelta?: (chunk: string) => void,
): Promise<CompletionResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  const calls = new Map<number, { id: string; name: string; args: string }>();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') continue;
      let delta: StreamDelta | null = null;
      try {
        const parsed = JSON.parse(data) as { choices?: Array<{ delta?: StreamDelta }> };
        delta = parsed.choices?.[0]?.delta ?? null;
      } catch {
        continue;
      }
      if (!delta) continue;
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        content += delta.content;
        onDelta?.(delta.content);
      }
      for (const [i, tc] of (delta.tool_calls ?? []).entries()) {
        const index = tc.index ?? i;
        const cur = calls.get(index) ?? { id: '', name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name = tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        calls.set(index, cur);
      }
    }
  }

  const toolCalls: ToolCall[] = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, c]) => ({
      id: c.id || `stream_${index}`,
      name: c.name,
      args: parseArgs(c.args),
    }))
    .filter((c) => c.name.length > 0);

  return { content, toolCalls };
}

function parseCompletion(raw: unknown): CompletionResult {
  const choice = (raw as { choices?: Array<{ message?: Record<string, unknown> }> }).choices?.[0];
  const msg = choice?.message ?? {};
  const content = typeof msg.content === 'string' ? msg.content : '';
  const toolCalls: ToolCall[] = [];
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      const rec = tc as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
      const name = typeof rec.function?.name === 'string' ? rec.function.name : '';
      if (!name) continue;
      toolCalls.push({
        id: typeof rec.id === 'string' ? rec.id : `call_${toolCalls.length}`,
        name,
        args: parseArgs(
          typeof rec.function?.arguments === 'string' ? rec.function.arguments : '{}',
        ),
      });
    }
  }
  return { content, toolCalls };
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}') as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** One-shot completion used by the settings "Test AI" button. */
export async function testProvider(provider: StoredProvider): Promise<string> {
  const result = await chatCompletion(provider, {
    model: provider.model,
    messages: [
      { role: 'system', content: 'Reply with the single word: ok' },
      { role: 'user', content: 'ping' },
    ],
    temperature: 0,
    max_tokens: 16,
  });
  return result.content.trim() || '(empty response)';
}

/**
 * One-shot text completion (no tools), for callers outside the review agent
 * loop — e.g. the AI conflict resolver. Shares the same client, timeout, and
 * upstream-error handling as a review call.
 */
export async function completeText(
  provider: StoredProvider,
  system: string,
  user: string,
  opts: { maxTokens?: number; signal?: AbortSignal; onDelta?: (chunk: string) => void } = {},
): Promise<string> {
  const result = await chatCompletion(
    provider,
    {
      model: provider.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: provider.temperature,
      max_tokens: opts.maxTokens ?? provider.maxTokens,
      stream: true,
    },
    opts.onDelta,
    opts.signal,
    { cancelled: 'AI request cancelled', timeout: 'AI request timed out' },
  );
  return result.content;
}
