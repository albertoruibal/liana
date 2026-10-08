// Theme picker and application.

import { loadedCode } from './code-loader';
import { $ } from './dom';
import { recolorTerminals } from './terminal';

// Theme picker and application.
const THEME_KEY = 'liana-theme';

interface ThemeDef {
  id: string;
  label: string;
  /** [accent, secondary] used for the swatch in the picker. */
  swatch: [string, string];
  dark: boolean;
}

const THEMES: ThemeDef[] = [
  { id: 'midnight', label: 'Midnight', swatch: ['#a78bfa', '#22d3ee'], dark: true },
  { id: 'dracula', label: 'Dracula', swatch: ['#bd93f9', '#8be9fd'], dark: true },
  { id: 'nord', label: 'Nord', swatch: ['#88c0d0', '#81a1c1'], dark: true },
  { id: 'gruvbox', label: 'Gruvbox', swatch: ['#d79921', '#b8bb26'], dark: true },
  { id: 'solarized', label: 'Solarized', swatch: ['#268bd2', '#2aa198'], dark: true },
  { id: 'phosphor', label: 'Phosphor', swatch: ['#35ff6d', '#7dffb0'], dark: true },
  { id: 'tokyo-night', label: 'Tokyo Night', swatch: ['#7aa2f7', '#bb9af7'], dark: true },
  { id: 'catppuccin', label: 'Catppuccin Mocha', swatch: ['#cba6f7', '#89dceb'], dark: true },
  { id: 'one-dark', label: 'One Dark', swatch: ['#61afef', '#c678dd'], dark: true },
  { id: 'monokai', label: 'Monokai', swatch: ['#f92672', '#a6e22e'], dark: true },
  { id: 'rose-pine', label: 'Rosé Pine', swatch: ['#c4a7e7', '#ebbcba'], dark: true },
  { id: 'everforest', label: 'Everforest', swatch: ['#a7c080', '#dbbc7f'], dark: true },
  { id: 'synthwave', label: "Synthwave '84", swatch: ['#ff7edb', '#36f9f6'], dark: true },
  { id: 'ayu-dark', label: 'Ayu Dark', swatch: ['#ffb454', '#39bae6'], dark: true },
  { id: 'light', label: 'Light', swatch: ['#7c3aed', '#0891b2'], dark: false },
];

const DEFAULT_THEME = 'midnight';

function isThemeId(id: string | undefined | null): id is string {
  return !!id && THEMES.some((t) => t.id === id);
}

export function currentTheme(): string {
  const id = document.documentElement.dataset.theme;
  return isThemeId(id) ? id : DEFAULT_THEME;
}

export function applyTheme(theme: string): void {
  const id = isThemeId(theme) ? theme : DEFAULT_THEME;
  document.documentElement.dataset.theme = id;
  document.querySelectorAll<HTMLButtonElement>('.theme-option').forEach((btn) => {
    btn.setAttribute('aria-checked', String(btn.dataset.themeValue === id));
  });
  // Keep any mounted Monaco editors in step with the theme.
  const codeModule = loadedCode();
  if (codeModule) codeModule.applyTheme();
  // Recolor any live embedded terminals from the new CSS variables.
  recolorTerminals();
}

function selectTheme(theme: string): void {
  if (!isThemeId(theme)) return;
  applyTheme(theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // localStorage may be unavailable (private mode); theme still applies in-session.
  }
}

/** Build the theme grid inside the settings dialog. */
export function buildThemeOptions(): void {
  const wrap = $('#theme-options');
  wrap.replaceChildren();
  for (const theme of THEMES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-option';
    btn.dataset.themeValue = theme.id;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', 'false');

    const swatch = document.createElement('span');
    swatch.className = 'theme-swatch';
    swatch.style.background = `linear-gradient(135deg, ${theme.swatch[0]} 0%, ${theme.swatch[1]} 100%)`;

    const label = document.createElement('span');
    label.textContent = theme.label;

    const check = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    check.setAttribute('viewBox', '0 0 16 16');
    check.setAttribute('aria-hidden', 'true');
    check.classList.add('theme-check');
    const tick = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    tick.setAttribute('d', 'M3.2 8.4 6.4 11.6 12.8 4.8');
    tick.setAttribute('fill', 'none');
    tick.setAttribute('stroke', 'currentColor');
    tick.setAttribute('stroke-width', '1.8');
    tick.setAttribute('stroke-linecap', 'round');
    tick.setAttribute('stroke-linejoin', 'round');
    check.appendChild(tick);

    btn.append(swatch, label, check);
    btn.addEventListener('click', () => selectTheme(theme.id));
    wrap.appendChild(btn);
  }
  applyTheme(currentTheme());
}

export function initTheme(): void {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(THEME_KEY);
  } catch {
    // ignore
  }
  applyTheme(isThemeId(stored) ? stored : DEFAULT_THEME);
}
