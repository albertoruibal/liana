// Settings dialog: AI providers, review rules, and Git hosting.

import { api } from './api-client';
import { esc } from './format';
import { buildThemeOptions } from './theme';
import { $ } from './dom';
import { AiModelInfo, AiProviderConfig, AppSettings } from '../types';
import { applyTheme, currentTheme } from './theme';
import { closeMoreMenu } from './more-menu';

// --- Settings dialog: AI providers, review rules, Git hosting ---
/** K unit for the token/char fields: input is in K, stored value is ×1024. */
const K = 1024;

/** Format a stored token/char count as a K input value (e.g. 8192 → "8"). */
function toK(n: number): string {
  const k = n / K;
  return String(Number.isInteger(k) ? k : Math.round(k * 10) / 10);
}

/** Parse a K input value back to a stored count (rounding to whole units). */
function fromK(raw: string | undefined, fallback: number): number {
  const k = Number.parseFloat(raw ?? '');
  return Number.isFinite(k) && k > 0 ? Math.round(k * K) : fallback;
}

/** Provider list being edited; secrets stay represented by `hasKey`. */
export let settingsProviders: AiProviderConfig[] = [];

export let settingsActiveProviderId: string | null = null;

/** Newly typed provider keys, keyed by provider id; sent only when non-empty. */
export const settingsNewKeys = new Map<string, string>();

export function renderProviderList(): void {
  const ul = $('#settings-providers');
  if (settingsProviders.length === 0) {
    ul.innerHTML = '<li class="provider-empty muted">No providers yet. Add one below.</li>';
    return;
  }
  ul.innerHTML = settingsProviders
    .map(
      (p, i) => `
      <li class="provider-item" data-index="${i}">
        <label class="provider-active">
          <input type="radio" name="active-provider" ${p.id === settingsActiveProviderId ? 'checked' : ''} />
          <span class="provider-active-label">active</span>
        </label>
        <div class="provider-fields">
          <div class="provider-row">
            <input type="text" class="pf-name" placeholder="Name" value="${esc(p.name)}" />
            <select class="pf-model-select" title="Models retrieved from the endpoint" hidden></select>
            <input type="text" class="pf-model" placeholder="Model (e.g. qwen2.5-coder:7b)" value="${esc(p.model)}" />
            <button type="button" class="btn pf-models" title="Retrieve the model list from the endpoint">Retrieve</button>
          </div>
          <input type="text" class="pf-url" placeholder="Base URL (…/v1)" value="${esc(p.baseUrl)}" />
          <input type="password" class="pf-key" autocomplete="off"
            placeholder="${p.hasKey ? 'Token saved — leave blank to keep' : 'API token (optional for local models)'}" />
          <div class="provider-row">
            <label class="pf-small">Context (K)
              <input type="number" class="pf-context" min="0.5" step="0.1" value="${toK(p.contextWindow)}" />
            </label>
            <label class="pf-small">Max tokens (K)
              <input type="number" class="pf-maxtokens" min="0.1" step="0.1" value="${toK(p.maxTokens)}" />
            </label>
            <label class="pf-small">Max steps
              <input type="number" class="pf-maxsteps" min="1" value="${p.maxSteps}" />
            </label>
          </div>
          <div class="provider-row">
            <label class="pf-small">Result chars (K)
              <input type="number" class="pf-resultchars" min="0.2" step="0.1" value="${toK(p.toolResultChars)}" />
            </label>
            <label class="pf-small">Temperature
              <input type="number" class="pf-temp" step="0.1" min="0" value="${p.temperature}" />
            </label>
            <button type="button" class="btn pf-test">Test</button>
            <button type="button" class="btn pf-remove">Remove</button>
          </div>
        </div>
      </li>`,
    )
    .join('');
}

/** Pull the current DOM values back into `settingsProviders`. */
export function readProviderInputs(): void {
  const items = document.querySelectorAll<HTMLLIElement>('#settings-providers .provider-item');
  items.forEach((li) => {
    const i = Number(li.dataset.index);
    const p = settingsProviders[i];
    if (!p) return;
    const q = <T extends HTMLElement>(sel: string): T | null => li.querySelector<T>(sel);
    p.name = q<HTMLInputElement>('.pf-name')?.value.trim() || p.name;
    p.model = q<HTMLInputElement>('.pf-model')?.value.trim() ?? p.model;
    p.baseUrl = q<HTMLInputElement>('.pf-url')?.value.trim() || p.baseUrl;
    p.contextWindow = fromK(q<HTMLInputElement>('.pf-context')?.value, p.contextWindow);
    p.maxTokens = fromK(q<HTMLInputElement>('.pf-maxtokens')?.value, p.maxTokens);
    p.maxSteps = Number(q<HTMLInputElement>('.pf-maxsteps')?.value) || p.maxSteps;
    p.toolResultChars = fromK(q<HTMLInputElement>('.pf-resultchars')?.value, p.toolResultChars);
    p.temperature = Number(q<HTMLInputElement>('.pf-temp')?.value) || p.temperature;
    const radio = li.querySelector<HTMLInputElement>('input[name="active-provider"]');
    if (radio?.checked) settingsActiveProviderId = p.id;
  });
  // The key input is only sent when the user typed a new value.
  items.forEach((li) => {
    const i = Number(li.dataset.index);
    const p = settingsProviders[i];
    const key = li.querySelector<HTMLInputElement>('.pf-key')?.value.trim();
    if (p && key) settingsNewKeys.set(p.id, key);
  });
}

export function showSettingsTab(tab: string): void {
  document.querySelectorAll<HTMLButtonElement>('.settings-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  document.querySelectorAll<HTMLElement>('.settings-panel').forEach((p) => {
    p.hidden = p.dataset.panel !== tab;
  });
  if (tab === 'theme') applyTheme(currentTheme());
}

export async function openSettingsDialog(): Promise<void> {
  const dlg = $<HTMLDialogElement>('#settings-dialog');
  const status = $('#settings-status');
  status.textContent = '';
  settingsNewKeys.clear();
  try {
    const s = await api<AppSettings>('/settings', undefined, { scoped: false });
    settingsProviders = s.ai.providers;
    settingsActiveProviderId = s.ai.activeProviderId;
    renderProviderList();

    $<HTMLTextAreaElement>('#settings-review-instructions').value = s.review.instructions;
    $<HTMLSelectElement>('#settings-review-severity').value = s.review.severityThreshold;
    $<HTMLInputElement>('#settings-review-maxcomments').value = String(s.review.maxComments);
    $<HTMLInputElement>('#settings-review-language').value = s.review.language;
    $<HTMLInputElement>('#settings-review-maxsteps').value = String(s.review.maxSteps);
    $<HTMLTextAreaElement>('#settings-review-ignore').value = s.review.ignoreGlobs.join('\n');
    $<HTMLInputElement>('#settings-review-batch').checked = s.review.batchByFile;

    $<HTMLTextAreaElement>('#settings-commit-instructions').value = s.commit.instructions;
    $<HTMLInputElement>('#settings-commit-language').value = s.commit.language;
    $<HTMLInputElement>('#settings-commit-maxdiff').value = String(s.commit.maxDiffChars);
    $<HTMLInputElement>('#settings-commit-history').checked = s.commit.includeHistory;

    $<HTMLInputElement>('#settings-gitlab-url').value = s.gitlab.baseUrl;
    $<HTMLInputElement>('#settings-gitlab-token').value = '';
    $<HTMLInputElement>('#settings-gitlab-project').value = s.gitlab.projectId;
    $('#settings-gitlab-note').textContent = s.gitlab.hasToken
      ? 'A token is saved. Leave the field blank to keep it.'
      : 'No token saved yet.';

    $<HTMLInputElement>('#settings-github-url').value = s.github.baseUrl;
    $<HTMLInputElement>('#settings-github-token').value = '';
    $<HTMLInputElement>('#settings-github-repo').value = s.github.repo;
    $('#settings-github-note').textContent = s.github.hasToken
      ? 'A token is saved. Leave the field blank to keep it.'
      : 'No token saved yet.';
    $<HTMLSelectElement>('#settings-forge').value = s.forge;
  } catch (err) {
    status.textContent = String(err);
  }
  buildThemeOptions();
  showSettingsTab('ai');
  dlg.showModal();
}

export function collectSettingsPatch(): Record<string, unknown> {
  readProviderInputs();
  const tokenValue = $<HTMLInputElement>('#settings-gitlab-token').value;
  const githubTokenValue = $<HTMLInputElement>('#settings-github-token').value;
  const providers = settingsProviders.map((p) => {
    const out: Record<string, unknown> = {
      id: p.id,
      name: p.name,
      baseUrl: p.baseUrl,
      model: p.model,
      contextWindow: p.contextWindow,
      maxTokens: p.maxTokens,
      temperature: p.temperature,
      toolResultChars: p.toolResultChars,
      maxSteps: p.maxSteps,
    };
    const key = settingsNewKeys.get(p.id);
    if (key) out.apiKey = key;
    return out;
  });
  return {
    ai: { providers, activeProviderId: settingsActiveProviderId },
    review: {
      instructions: $<HTMLTextAreaElement>('#settings-review-instructions').value,
      severityThreshold: $<HTMLSelectElement>('#settings-review-severity').value,
      maxComments: Number($<HTMLInputElement>('#settings-review-maxcomments').value) || 0,
      language: $<HTMLInputElement>('#settings-review-language').value.trim() || 'English',
      maxSteps: Number($<HTMLInputElement>('#settings-review-maxsteps').value) || 8,
      ignoreGlobs: $<HTMLTextAreaElement>('#settings-review-ignore')
        .value.split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
      batchByFile: $<HTMLInputElement>('#settings-review-batch').checked,
    },
    commit: {
      instructions: $<HTMLTextAreaElement>('#settings-commit-instructions').value,
      language: $<HTMLInputElement>('#settings-commit-language').value.trim() || 'English',
      includeHistory: $<HTMLInputElement>('#settings-commit-history').checked,
      maxDiffChars: Number($<HTMLInputElement>('#settings-commit-maxdiff').value) || 12000,
    },
    gitlab: {
      baseUrl: $<HTMLInputElement>('#settings-gitlab-url').value.trim(),
      // Omit when blank so an existing token is preserved.
      ...(tokenValue ? { token: tokenValue } : {}),
      projectId: $<HTMLInputElement>('#settings-gitlab-project').value.trim(),
    },
    github: {
      baseUrl: $<HTMLInputElement>('#settings-github-url').value.trim(),
      ...(githubTokenValue ? { token: githubTokenValue } : {}),
      repo: $<HTMLInputElement>('#settings-github-repo').value.trim(),
    },
    forge: ($<HTMLSelectElement>('#settings-forge').value as 'auto' | 'gitlab' | 'github'),
  };
}

/** Persist the current dialog state and refresh the provider list from the reply. */
export async function persistSettings(): Promise<void> {
  const s = await api<AppSettings>('/settings', collectSettingsPatch(), { scoped: false });
  settingsProviders = s.ai.providers;
  settingsActiveProviderId = s.ai.activeProviderId;
  renderProviderList();
}

/** Shared handler for the per-forge Test buttons: persist first, then probe. */
export function testForgeButton(forge: 'gitlab' | 'github', route: string, label: string): () => void {
  return () => {
    const status = $('#settings-status');
    void (async () => {
      try {
        status.textContent = `Testing ${label}…`;
        // Persist the edited fields first so the probe uses them.
        await persistSettings();
        const res = await api<{ username: string }>(route, forge === 'github' ? { forge } : {}, {
          scoped: false,
        });
        status.textContent = `${label} OK as ${res.username}.`;
      } catch (err) {
        status.textContent = String(err);
      }
    })();
  };
}

/** Per-provider Test button: persist first so the probe uses the edited fields. */
async function testProviderItem(li: HTMLLIElement): Promise<void> {
  const status = $('#settings-status');
  try {
    readProviderInputs();
    const provider = settingsProviders[Number(li.dataset.index)];
    if (!provider) return;
    const { id, name } = provider;
    await persistSettings();
    status.textContent = `Testing ${name}…`;
    const res = await api<{ reply: string }>('/settings/test-ai', { providerId: id }, { scoped: false });
    status.textContent = `AI OK (${name}): ${res.reply}`;
  } catch (err) {
    status.textContent = String(err);
  }
}

/** Apply model-reported context window / max tokens (in tokens) to a provider row. */
function applyModelParams(li: HTMLLIElement, context: number, maxTokens: number): void {
  if (Number.isFinite(context) && context > 0) {
    const ctx = li.querySelector<HTMLInputElement>('.pf-context');
    if (ctx) ctx.value = toK(context);
  }
  if (Number.isFinite(maxTokens) && maxTokens > 0) {
    const mt = li.querySelector<HTMLInputElement>('.pf-maxtokens');
    if (mt) mt.value = toK(maxTokens);
  }
}

/** Fill a provider row's model `<select>` with retrieved models; the text input stays editable. */
function populateModelSelect(li: HTMLLIElement, models: AiModelInfo[]): void {
  const select = li.querySelector<HTMLSelectElement>('.pf-model-select');
  if (!select) return;
  const current = li.querySelector<HTMLInputElement>('.pf-model')?.value.trim() ?? '';
  const option = (m: AiModelInfo, label = m.id): string => {
    const ctx = m.contextWindow !== undefined ? ` data-context="${m.contextWindow}"` : '';
    const max = m.maxTokens !== undefined ? ` data-maxtokens="${m.maxTokens}"` : '';
    return `<option value="${esc(m.id)}"${ctx}${max}>${esc(label)}</option>`;
  };
  select.innerHTML = [
    '<option value="">— pick a model —</option>',
    ...models.map((m) => option(m)),
    ...(current && !models.some((m) => m.id === current)
      ? [option({ id: current }, `${current} (current)`)]
      : []),
  ].join('');
  select.value = current;
  select.hidden = false;
  // Auto-fill the already-selected model's limits, if the API reported them.
  const match = models.find((m) => m.id === current);
  if (match) {
    applyModelParams(li, match.contextWindow ?? NaN, match.maxTokens ?? NaN);
  }
}

/**
 * Per-provider Retrieve button: persist the edited fields, then ask the endpoint
 * for its model list. Selecting a model fills the text input and, when the API
 * reports them, the context window and max-token fields.
 */
async function retrieveModelsItem(li: HTMLLIElement): Promise<void> {
  const status = $('#settings-status');
  try {
    readProviderInputs();
    const index = li.dataset.index;
    const provider = settingsProviders[Number(index)];
    if (!provider) return;
    const { id, name } = provider;
    await persistSettings();
    // persistSettings re-renders the list, so the original <li> is detached.
    const fresh = document.querySelector<HTMLLIElement>(
      `#settings-providers .provider-item[data-index="${index}"]`,
    );
    if (!fresh) return;
    status.textContent = `Retrieving models from ${name}…`;
    const res = await api<{ models: AiModelInfo[] }>(
      '/settings/ai-models',
      { providerId: id },
      { scoped: false },
    );
    if (res.models.length === 0) {
      status.textContent = `${name} reported no models. Enter one manually.`;
      return;
    }
    populateModelSelect(fresh, res.models);
    status.textContent = `Retrieved ${res.models.length} model(s) from ${name}.`;
  } catch (err) {
    status.textContent = String(err);
  }
}

export function initSettings(): void {
  $('#btn-settings').addEventListener('click', () => {
    closeMoreMenu();
    void openSettingsDialog();
  });

  document.querySelectorAll<HTMLButtonElement>('.settings-tab').forEach((btn) => {
    btn.addEventListener('click', () => showSettingsTab(btn.dataset.tab ?? 'ai'));
  });

  $('#settings-add-provider').addEventListener('click', () => {
    readProviderInputs();
    const id = `p${Date.now().toString(36)}`;
    settingsProviders.push({
      id,
      name: 'New provider',
      baseUrl: 'http://localhost:11434/v1',
      model: '',
      hasKey: false,
      contextWindow: 8192,
      maxTokens: 1024,
      temperature: 0.1,
      toolResultChars: 2048,
      maxSteps: 8,
    });
    if (!settingsActiveProviderId) settingsActiveProviderId = id;
    renderProviderList();
  });

  $('#settings-providers').addEventListener('click', (ev) => {
    const target = ev.target;
    if (!(target instanceof HTMLElement)) return;
    const li = target.closest<HTMLLIElement>('.provider-item');
    if (!li) return;
    if (target.classList.contains('pf-test')) {
      void testProviderItem(li);
      return;
    }
    if (target.classList.contains('pf-models')) {
      void retrieveModelsItem(li);
      return;
    }
    if (!target.classList.contains('pf-remove')) return;
    readProviderInputs();
    const i = Number(li.dataset.index);
    const removed = settingsProviders[i];
    settingsProviders.splice(i, 1);
    if (removed && settingsActiveProviderId === removed.id) {
      settingsActiveProviderId = settingsProviders[0]?.id ?? null;
    }
    renderProviderList();
  });

  $('#settings-providers').addEventListener('change', (ev) => {
    const target = ev.target;
    if (!(target instanceof HTMLSelectElement) || !target.classList.contains('pf-model-select')) return;
    const li = target.closest<HTMLLIElement>('.provider-item');
    if (!li) return;
    const model = target.value;
    if (!model) return;
    const input = li.querySelector<HTMLInputElement>('.pf-model');
    if (input) input.value = model;
    const option = target.selectedOptions[0];
    const context = Number(option?.dataset.context);
    const maxTokens = Number(option?.dataset.maxtokens);
    applyModelParams(li, context, maxTokens);
  });

  $('#settings-save').addEventListener('click', (ev) => {
    ev.preventDefault();
    const status = $('#settings-status');
    status.textContent = 'Saving…';
    void (async () => {
      try {
        await persistSettings();
        status.textContent = 'Saved.';
      } catch (err) {
        status.textContent = String(err);
      }
    })();
  });

  $('#settings-test-gitlab').addEventListener(
    'click',
    testForgeButton('gitlab', '/settings/test-gitlab', 'GitLab'),
  );

  $('#settings-test-github').addEventListener(
    'click',
    testForgeButton('github', '/settings/test-forge', 'GitHub'),
  );

  $('#settings-cancel').addEventListener('click', (ev) => {
    ev.preventDefault();
    $<HTMLDialogElement>('#settings-dialog').close();
  });
}
