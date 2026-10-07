// AI commit-message generation (one-shot, low temperature). Node-only.

import { activeProvider, providerById } from '../settings';
import { chatCompletion } from './ai';
import type { CommitMessageConfig } from '../types';

/** Strip a markdown code fence and surrounding whitespace from a model reply. */
function cleanCommitMessage(raw: string): string {
  const unfenced = raw.replace(/^\s*```[^\n]*\n?/i, '').replace(/\n?```\s*$/i, '');
  return unfenced.trim();
}

/** System prompt for commit-message generation. */
function buildCommitSystemPrompt(rule: CommitMessageConfig, includeHistory: boolean): string {
  const lines = [
    'You write git commit messages.',
    `Write in ${rule.language}.`,
    rule.instructions,
    'Use the imperative mood in the subject line and keep it under 72 characters.',
    'Add a short body separated by a blank line only when it helps explain why.',
  ];
  if (includeHistory) {
    lines.push('Match the style of the recent commits shown below.');
  }
  lines.push(
    'Reply with the commit message only — no code fences, no preamble, no explanation.',
  );
  return lines.join('\n');
}

export interface CommitMessageInput {
  /** Unified diff text for the changes being committed. */
  diff: string;
  /** Recent commit subjects, newest first, for style matching. */
  history?: string[];
}

/**
 * Generate a commit message for the given changes with the active provider.
 * One-shot, low temperature; the same OpenAI-compatible endpoint reviews use.
 */
export async function generateCommitMessage(
  rule: CommitMessageConfig,
  input: CommitMessageInput,
  providerId?: string,
): Promise<string> {
  const provider =
    providerId !== undefined ? (providerById(providerId) ?? activeProvider()) : activeProvider();
  if (!provider) throw new Error('No AI provider configured — add one in Settings');
  if (!provider.model.trim()) throw new Error('No model set for the active AI provider');

  const history =
    rule.includeHistory && input.history && input.history.length > 0
      ? `Recent commits (newest first):\n${input.history.map((s) => `- ${s}`).join('\n')}`
      : '';
  const user = [
    'Changes to commit:',
    input.diff || '(no diff available)',
    history ? `\n${history}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const result = await chatCompletion(provider, {
    model: provider.model,
    messages: [
      { role: 'system', content: buildCommitSystemPrompt(rule, Boolean(history)) },
      { role: 'user', content: user },
    ],
    temperature: Math.min(provider.temperature, 0.5),
    max_tokens: Math.min(provider.maxTokens, 512),
  });
  return cleanCommitMessage(result.content);
}
