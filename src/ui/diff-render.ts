// HTML fallback diff renderers (unified and split).

import { DiffView } from './diff-view';
import { esc, gutter } from './format';
import { DiffLine, DiffSection, SplitRow, pairHunk, parsePatch } from '../diff';

/** Render parsed diff sections as a unified (single-column) table. */
export function renderUnified(sections: DiffSection[]): string {
  const rows: string[] = [];
  for (const section of sections) {
    for (const line of section.meta) {
      rows.push(`<div class="dl-row dl-meta">${esc(line.text)}</div>`);
    }
    for (const hunk of section.hunks) {
      rows.push(`<div class="dl-row dl-hunk">${esc(hunk.header)}</div>`);
      for (const line of hunk.lines) {
        if (line.kind === 'nonewline') {
          rows.push(`<div class="dl-row dl-nonewline">${esc(line.text)}</div>`);
          continue;
        }
        const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
        rows.push(
          `<div class="dl-row dl-${line.kind}">${gutter(line.oldNo)}${gutter(line.newNo)}<span class="dl-sign">${sign}</span><span class="dl-text">${esc(line.text)}</span></div>`,
        );
      }
    }
  }
  return rows.join('');
}

/** One cell of the split view: line number + text, or a blank filler. */
export function splitCell(line: DiffLine | null, side: 'old' | 'new'): string {
  if (!line) return '<div class="dl-cell dl-empty"></div>';
  const no = side === 'old' ? line.oldNo : line.newNo;
  return `<div class="dl-cell dl-${line.kind}">${gutter(no)}<span class="dl-text">${esc(line.text)}</span></div>`;
}

/** Render parsed diff sections as two independent old | new scroll panes. */
export function renderSplit(sections: DiffSection[]): string {
  const oldRows: string[] = [];
  const newRows: string[] = [];
  for (const section of sections) {
    for (const line of section.meta) {
      const html = `<div class="dl-meta split-meta">${esc(line.text)}</div>`;
      oldRows.push(html);
      newRows.push(html);
    }
    for (const hunk of section.hunks) {
      const header = `<div class="dl-hunk split-meta">${esc(hunk.header)}</div>`;
      oldRows.push(header);
      newRows.push(header);
      const pairs: SplitRow[] = pairHunk(hunk);
      for (const [left, right] of pairs) {
        oldRows.push(splitCell(left, 'old'));
        newRows.push(splitCell(right, 'new'));
      }
    }
  }
  return (
    `<div class="dl-split">` +
    `<div class="dl-split-pane dl-split-old">${oldRows.join('')}</div>` +
    `<div class="dl-split-pane dl-split-new">${newRows.join('')}</div>` +
    `</div>`
  );
}

/** Render the dialog body for the given layout. */
export function renderDiffBody(patch: string, view: DiffView): string {
  const sections = patch ? parsePatch(patch) : [];
  if (sections.length === 0) return '<div class="dl-note">No textual diff.</div>';
  return view === 'split' ? renderSplit(sections) : renderUnified(sections);
}
