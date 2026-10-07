// Monaco integration, dynamically imported so the (large) editor and its language
// workers stay out of the initial bundle and only load the first time a code view
// opens. Exposes thin wrappers the UI drives; the UI keeps its own HTML fallback.
//
// Browser-only: this module must never be imported by the Node backend or by
// `src/api.ts`. All Monaco assets are bundled locally (no CDN), so it works offline
// under the packaged Electron loopback server too.

import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

// Route each language to its worker. Vite bundles the `?worker` imports as
// separate chunks and hands back a constructor that works in dev and build.
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    switch (label) {
      case 'json':
        return new jsonWorker();
      case 'css':
      case 'scss':
      case 'less':
        return new cssWorker();
      case 'html':
      case 'handlebars':
      case 'razor':
        return new htmlWorker();
      case 'typescript':
      case 'javascript':
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

/** Liana dark theme ids, mapped to Monaco's `vs-dark` base. Anything else is light. */
const DARK_THEMES = new Set([
  'midnight',
  'dracula',
  'nord',
  'one-dark',
  'everforest',
  'synthwave',
  'ayu-dark',
]);

/** Read a CSS custom property from the document, falling back when unset. */
function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/** Define a Monaco theme that follows the active Liana theme's tokens; return its id. */
function ensureTheme(): string {
  const id = document.documentElement.dataset.theme ?? 'midnight';
  const dark = DARK_THEMES.has(id);
  const name = `liana-${id}`;
  monaco.editor.defineTheme(name, {
    base: dark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': cssVar('--bg-elev-2', dark ? '#1d1830' : '#ffffff'),
      'editor.foreground': cssVar('--fg', dark ? '#ece9f5' : '#1c1730'),
      'editorLineNumber.foreground': cssVar('--fg-faint', '#6b6485'),
      'editorGutter.background': cssVar('--bg-elev-2', dark ? '#1d1830' : '#ffffff'),
      'editor.lineHighlightBackground': cssVar('--bg-hover', dark ? '#241e3c' : '#f3f1fb'),
      'diffEditor.insertedTextBackground': `${cssVar('--add', '#34d399')}33`,
      'diffEditor.removedTextBackground': `${cssVar('--del', '#fb7185')}33`,
    },
  });
  return name;
}

/** Pick a Monaco language id from a file extension (Monaco falls back to plaintext). */
function languageFor(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const byExt: Record<string, string> = {
    js: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    json: 'json',
    jsonc: 'json',
    html: 'html',
    htm: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    md: 'markdown',
    markdown: 'markdown',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    cc: 'cpp',
    hpp: 'cpp',
    cs: 'csharp',
    sh: 'shell',
    bash: 'shell',
    yml: 'yaml',
    yaml: 'yaml',
    xml: 'xml',
    svg: 'xml',
    sql: 'sql',
  };
  return byExt[ext] ?? 'plaintext';
}

/** Shared editor options, computed per call so the active theme's font applies. */
function commonOptions(): monaco.editor.IStandaloneEditorConstructionOptions {
  return {
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontSize: 12,
    fontFamily: cssVar('--mono', 'monospace'),
    renderWhitespace: 'selection',
    smoothScrolling: true,
    contextmenu: false,
  };
}

/** A live Monaco editor bound to a container in a dialog. */
export interface CodeHandle {
  kind: 'editor' | 'diff';
  /** Set the text of a single (non-diff) editor. No-op for diff handles. */
  setValue(value: string): void;
  /** Current text (the modified side for a diff handle). */
  getValue(): string;
  /** Switch a diff handle between split and inline layouts. No-op otherwise. */
  setSideBySide(sideBySide: boolean): void;
  /** Focus the editor so shortcuts land inside Monaco. */
  focus(): void;
  dispose(): void;
}

/**
 * Whole-line Monaco decorations marking git conflict-marker regions: the ours
 * side (`<<<<<<<` … `=======`), the diff3 base (`|||||||` … `=======`), the
 * theirs side (`=======` … `>>>>>>>`), and the delimiter lines themselves.
 */
function conflictMarkerDecorations(model: monaco.editor.ITextModel): monaco.editor.IModelDeltaDecoration[] {
  const decorations: monaco.editor.IModelDeltaDecoration[] = [];
  const add = (line: number, className: string): void => {
    decorations.push({
      range: new monaco.Range(line, 1, line, 1),
      options: { isWholeLine: true, className, marginClassName: className },
    });
  };
  let region: 'ours' | 'base' | 'theirs' | null = null;
  for (let i = 1; i <= model.getLineCount(); i++) {
    const line = model.getLineContent(i);
    if (line.startsWith('<<<<<<<')) {
      region = 'ours';
      add(i, 'conflict-marker-delim');
    } else if (line.startsWith('|||||||')) {
      region = 'base';
      add(i, 'conflict-marker-delim');
    } else if (line.startsWith('=======')) {
      region = region === 'ours' ? 'theirs' : null;
      add(i, 'conflict-marker-delim');
    } else if (line.startsWith('>>>>>>>')) {
      region = null;
      add(i, 'conflict-marker-delim');
    } else if (region === 'ours') {
      add(i, 'conflict-marker-ours');
    } else if (region === 'base') {
      add(i, 'conflict-marker-base');
    } else if (region === 'theirs') {
      add(i, 'conflict-marker-theirs');
    }
  }
  return decorations;
}

/** Create a plain editor showing `value`; editable unless `readOnly` (default true). */
export function createEditor(
  container: HTMLElement,
  value: string,
  opts: { path?: string; readOnly?: boolean; conflictMarkers?: boolean } = {},
): CodeHandle {
  const editor = monaco.editor.create(container, {
    ...commonOptions(),
    value,
    readOnly: opts.readOnly ?? true,
    language: opts.path ? languageFor(opts.path) : 'plaintext',
    theme: ensureTheme(),
  });
  let markerCollection: monaco.editor.IEditorDecorationsCollection | null = null;
  let contentSub: monaco.IDisposable | null = null;
  if (opts.conflictMarkers) {
    const model = editor.getModel();
    if (model) {
      markerCollection = editor.createDecorationsCollection(conflictMarkerDecorations(model));
      contentSub = model.onDidChangeContent(() => {
        markerCollection?.set(conflictMarkerDecorations(model));
      });
    }
  }
  return {
    kind: 'editor',
    setValue: (next) => editor.setValue(next),
    getValue: () => editor.getValue(),
    setSideBySide: () => {},
    focus: () => editor.focus(),
    dispose: () => {
      contentSub?.dispose();
      markerCollection?.clear();
      editor.dispose();
    },
  };
}

/**
 * Create a Monaco diff editor comparing `original` against `modified` (read-only).
 * `lineNumbers.original`/`.modified` map each model line (index 0 = first line) to
 * the real file line number to display, for excerpts that start mid-file.
 * `anchors` lists real line numbers to highlight on the matching side.
 */
export function createDiffEditor(
  container: HTMLElement,
  original: string,
  modified: string,
  opts: {
    path?: string;
    sideBySide?: boolean;
    lineNumbers?: { original?: number[]; modified?: number[] };
    anchors?: { original?: number[]; modified?: number[] };
  } = {},
): CodeHandle {
  const editor = monaco.editor.createDiffEditor(container, {
    ...commonOptions(),
    readOnly: true,
    originalEditable: false,
    renderSideBySide: opts.sideBySide ?? true,
    theme: ensureTheme(),
  });
  const language = opts.path ? languageFor(opts.path) : 'plaintext';
  const originalModel = monaco.editor.createModel(original, language);
  const modifiedModel = monaco.editor.createModel(modified, language);
  // Set the model first: assigning it clears any decorations on the sub-editors.
  editor.setModel({ original: originalModel, modified: modifiedModel });
  // `lineNumbers` is an editor option, so map each side after the model is set.
  if (opts.lineNumbers?.original) {
    editor.getOriginalEditor().updateOptions({ lineNumbers: lineNumberMapper(opts.lineNumbers.original) });
  }
  if (opts.lineNumbers?.modified) {
    editor.getModifiedEditor().updateOptions({ lineNumbers: lineNumberMapper(opts.lineNumbers.modified) });
  }
  // Highlight the anchor line(s) on each side.
  const decorations: monaco.editor.IEditorDecorationsCollection[] = [];
  const decorate = (side: 'original' | 'modified', lines: number[]): void => {
    const target = side === 'original' ? editor.getOriginalEditor() : editor.getModifiedEditor();
    decorations.push(
      target.createDecorationsCollection(
        lines.map((line) => ({
          range: new monaco.Range(line, 1, line, 1),
          options: { isWholeLine: true, className: 'review-excerpt-anchor' },
        })),
      ),
    );
  };
  if (opts.anchors?.original?.length) decorate('original', opts.anchors.original);
  if (opts.anchors?.modified?.length) decorate('modified', opts.anchors.modified);
  return {
    kind: 'diff',
    setValue: () => {},
    getValue: () => modifiedModel.getValue(),
    setSideBySide: (sideBySide) => editor.updateOptions({ renderSideBySide: sideBySide }),
    focus: () => editor.focus(),
    dispose: () => {
      for (const d of decorations) d.clear();
      editor.dispose();
      originalModel.dispose();
      modifiedModel.dispose();
    },
  };
}

/** Monaco `lineNumbers` callback mapping a 1-based display index to the real line. */
function lineNumberMapper(lines: number[]): (n: number) => string {
  return (n) => `${lines[n - 1] ?? n}`;
}

/** Re-theme all Monaco editors after a Liana theme switch. */
export function applyTheme(): void {
  monaco.editor.setTheme(ensureTheme());
}
