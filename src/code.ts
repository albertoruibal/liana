// Monaco integration, dynamically imported so the (large) editor and its language
// workers stay out of the initial bundle and only load the first time a code view
// opens. Exposes thin wrappers the UI drives; the UI keeps its own HTML fallback.
//
// Browser-only: this module must never be imported by the Node backend or by
// `src/api.ts`. All Monaco assets are bundled locally (no CDN), so it works offline
// under the packaged Electron loopback server too.

import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/languages/features/json/json.worker?worker';
import cssWorker from 'monaco-editor/languages/features/css/css.worker?worker';
import htmlWorker from 'monaco-editor/languages/features/html/html.worker?worker';
import tsWorker from 'monaco-editor/languages/features/typescript/ts.worker?worker';

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
  /** Run `cb` whenever this editor scrolls (used to sync sibling panes). */
  onDidScroll(cb: () => void): void;
  /** Current scroll offsets of the (modified side for a diff handle). */
  getScrollPosition(): { top: number; left: number };
  /** Jump to a scroll offset without animation (for syncing sibling panes). */
  setScrollPosition(top: number, left: number): void;
  /** Track a 1-based inclusive line range that follows edits; returns an opaque id. */
  trackLineRange(startLine: number, endLine: number): string;
  /** Current 1-based inclusive line range for a tracked id, or null when it was lost. */
  getTrackedLineRange(id: string): { startLine: number; endLine: number } | null;
  /** Replace a tracked full-line range, returning the id re-anchored to the new text. */
  replaceTrackedRange(id: string, text: string): string | null;
  /** Center a 1-based inclusive line range and put the cursor on its first line. */
  revealLineRange(startLine: number, endLine: number): void;
  dispose(): void;
}

/** Scroll accessors shared by standalone editors and the modified side of a diff. */
function scrollControl(editor: monaco.editor.ICodeEditor): {
  api: Pick<CodeHandle, 'onDidScroll' | 'getScrollPosition' | 'setScrollPosition'>;
  dispose(): void;
} {
  const listeners = new Set<() => void>();
  const sub = editor.onDidScrollChange(() => {
    for (const cb of listeners) cb();
  });
  return {
    api: {
      onDidScroll: (cb) => {
        listeners.add(cb);
      },
      getScrollPosition: () => ({ top: editor.getScrollTop(), left: editor.getScrollLeft() }),
      setScrollPosition: (top, left) => {
        const type = monaco.editor.ScrollType.Immediate;
        editor.setScrollTop(top, type);
        editor.setScrollLeft(left, type);
      },
    },
    dispose: () => {
      listeners.clear();
      sub.dispose();
    },
  };
}

/** Clamp a 1-based inclusive line range to the model and cover whole lines. */
function fullLineRange(
  model: monaco.editor.ITextModel,
  startLine: number,
  endLine: number,
): monaco.Range {
  const count = model.getLineCount();
  const start = Math.min(Math.max(1, startLine), count);
  const end = Math.min(Math.max(start, endLine), count);
  return new monaco.Range(start, 1, end, model.getLineMaxColumn(end));
}

/** Line-range tracking helpers shared by editable Monaco editors. */
function trackedRangeControl(editor: monaco.editor.IStandaloneCodeEditor): {
  api: Pick<
    CodeHandle,
    'trackLineRange' | 'getTrackedLineRange' | 'replaceTrackedRange' | 'revealLineRange'
  >;
} {
  const stickiness = monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges;
  return {
    api: {
      trackLineRange: (startLine, endLine) => {
        const model = editor.getModel();
        if (!model) return '';
        const [id] = model.deltaDecorations(
          [],
          [{ range: fullLineRange(model, startLine, endLine), options: { stickiness } }],
        );
        return id ?? '';
      },
      getTrackedLineRange: (id) => {
        const model = editor.getModel();
        if (!model) return null;
        const range = model.getDecorationRange(id);
        return range ? { startLine: range.startLineNumber, endLine: range.endLineNumber } : null;
      },
      replaceTrackedRange: (id, text) => {
        const model = editor.getModel();
        if (!model) return null;
        const range = model.getDecorationRange(id);
        if (!range) return null;
        const startLine = range.startLineNumber;
        const endLine = range.endLineNumber;
        const lines = text === '' ? [] : text.split('\n');
        const count = model.getLineCount();
        let editRange: monaco.Range;
        let insert: string;
        if (endLine < count) {
          // Replace the block and the line break after it, so empty output leaves
          // no blank line behind.
          editRange = new monaco.Range(startLine, 1, endLine + 1, 1);
          insert = lines.length ? `${lines.join('\n')}\n` : '';
        } else if (startLine > 1) {
          // Last line(s): include the preceding line break for the same reason.
          editRange = new monaco.Range(
            startLine - 1,
            model.getLineMaxColumn(startLine - 1),
            endLine,
            model.getLineMaxColumn(endLine),
          );
          insert = lines.length ? `\n${lines.join('\n')}` : '';
        } else {
          editRange = new monaco.Range(
            startLine,
            1,
            endLine,
            model.getLineMaxColumn(endLine),
          );
          insert = lines.length ? lines.join('\n') : '';
        }
        model.applyEdits([{ range: editRange, text: insert }]);
        const [nextId] = model.deltaDecorations(
          [id],
          [
            {
              range: fullLineRange(
                model,
                startLine,
                lines.length ? startLine + lines.length - 1 : startLine,
              ),
              options: { stickiness },
            },
          ],
        );
        return nextId ?? null;
      },
      revealLineRange: (startLine, endLine) => {
        const model = editor.getModel();
        if (!model) return;
        const range = fullLineRange(model, startLine, endLine);
        editor.revealRangeInCenter(range);
        editor.setPosition({ lineNumber: range.startLineNumber, column: 1 });
        editor.focus();
      },
    },
  };
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
  const scroll = scrollControl(editor);
  const tracked = trackedRangeControl(editor);
  return {
    kind: 'editor',
    setValue: (next) => editor.setValue(next),
    getValue: () => editor.getValue(),
    setSideBySide: () => {},
    focus: () => editor.focus(),
    onDidScroll: (cb) => scroll.api.onDidScroll(cb),
    getScrollPosition: () => scroll.api.getScrollPosition(),
    setScrollPosition: (top, left) => scroll.api.setScrollPosition(top, left),
    trackLineRange: (startLine, endLine) => tracked.api.trackLineRange(startLine, endLine),
    getTrackedLineRange: (id) => tracked.api.getTrackedLineRange(id),
    replaceTrackedRange: (id, text) => tracked.api.replaceTrackedRange(id, text),
    revealLineRange: (startLine, endLine) => tracked.api.revealLineRange(startLine, endLine),
    dispose: () => {
      scroll.dispose();
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
    /**
     * Whether the editor swallows wheel events even when it can't scroll
     * (Monaco's default). Set false for inline excerpts so the wheel chains to
     * the surrounding page once the editor has no overflow to consume.
     */
    consumeMouseWheel?: boolean;
  } = {},
): CodeHandle {
  const editor = monaco.editor.createDiffEditor(container, {
    ...commonOptions(),
    readOnly: true,
    originalEditable: false,
    renderSideBySide: opts.sideBySide ?? true,
    // Monaco paints the overview ruler's viewport thumb with the scrollbar-slider
    // color, so it reads as a second scrollbar beside the real one at the right.
    renderOverviewRuler: false,
    scrollbar: { alwaysConsumeMouseWheel: opts.consumeMouseWheel ?? true },
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
  // Inline diffs scroll as one; the modified sub-editor is the shared viewport.
  const scroll = scrollControl(editor.getModifiedEditor());
  return {
    kind: 'diff',
    setValue: () => {},
    getValue: () => modifiedModel.getValue(),
    setSideBySide: (sideBySide) => editor.updateOptions({ renderSideBySide: sideBySide }),
    focus: () => editor.focus(),
    onDidScroll: (cb) => scroll.api.onDidScroll(cb),
    getScrollPosition: () => scroll.api.getScrollPosition(),
    setScrollPosition: (top, left) => scroll.api.setScrollPosition(top, left),
    trackLineRange: () => '',
    getTrackedLineRange: () => null,
    replaceTrackedRange: () => null,
    revealLineRange: () => {},
    dispose: () => {
      scroll.dispose();
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
