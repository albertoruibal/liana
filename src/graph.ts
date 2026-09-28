// SVG rendering of the commit graph (GitKraken-like left pane).

import type { GraphLayout, RepoState } from './types';

const ROW_H = 40;
const COL_W = 28;
const DOT_R = 7;
const LABEL_FS = 12.5; // px, keep in sync with .graph-row-label in styles.css
const CHIP_H = 20;
// Gap between the lane (graph) area and the commit-text column on the right.
const COLUMN_GAP = 40;
// Gap between the ref/tag column on the left and the graph lanes.
const REF_GAP = 16;
const REF_PAD = 12;
// Fixed width reserved for the commit subject; the author column follows it.
const SUBJECT_W = 600;
// Gap between the commit subject column and the author column.
const AUTHOR_GAP = 24;
// Padding to the right of the author column.
const AUTHOR_PAD = 24;

// GitKraken-ish palette for lanes
const COLORS = [
  '#4fc3f7', // light blue
  '#f06292', // pink
  '#aed581', // light green
  '#ffd54f', // yellow
  '#ba68c8', // purple
  '#ff8a65', // orange
  '#4db6ac', // teal
  '#e57373', // red
  '#9575cd', // violet
  '#fff176', // pale yellow
];

export function laneColor(col: number): string {
  return COLORS[col % COLORS.length]!;
}

let hoverController: AbortController | null = null;

export function renderGraph(
  svg: SVGSVGElement,
  _state: RepoState,
  layout: GraphLayout,
  selectedHash: string | null = null,
): void {
  const ns = 'http://www.w3.org/2000/svg';
  const TOP_PAD = 24;
  const LEFT_PAD = 24;
  const y = (row: number) => TOP_PAD + row * ROW_H;

  const height = TOP_PAD + Math.max(1, layout.nodes.length) * ROW_H + TOP_PAD;
  svg.replaceChildren();

  // --- Measurement pass: build the ref/tag chips and size the left column. ---
  // Chips are appended (so they get a layout box and real text length) but only
  // positioned after we know how wide the column must be.
  interface Chip {
    text: SVGTextElement;
    isHead: boolean;
    width: number;
  }
  interface RefRow {
    cy: number;
    chips: Chip[];
  }
  const refRows: RefRow[] = [];
  let maxChipRowW = 0;

  for (const n of layout.nodes) {
    if (n.commit.refs.length === 0) continue;
    const cy = y(n.row);
    const sorted = [...n.commit.refs].sort((a, b) => (a === 'HEAD' ? -1 : b === 'HEAD' ? 1 : 0));
    const chips: Chip[] = [];
    let rowW = 0;
    for (const ref of sorted) {
      const isHead = ref === 'HEAD';
      const text = document.createElementNS(ns, 'text');
      text.setAttribute('y', String(cy + 4));
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('class', isHead ? 'ref-chip ref-head' : 'ref-chip');
      text.textContent = ref;
      svg.appendChild(text);
      const width = measureText(text) + 16;
      chips.push({ text, isHead, width });
      rowW += width + 6;
    }
    refRows.push({ cy, chips });
    maxChipRowW = Math.max(maxChipRowW, rowW - 6);
  }

  // Left column width (chips + padding), 0 when the repo has no refs.
  const refColumnW = maxChipRowW > 0 ? maxChipRowW + REF_PAD * 2 : 0;
  const laneLeft = refColumnW > 0 ? LEFT_PAD + refColumnW + REF_GAP : LEFT_PAD;
  const laneRight = laneLeft + layout.columns * COL_W;

  // Measurement pass for the author column: append the texts so they get a
  // layout box, size the column to the longest name, then reposition later.
  // Author sits between the lanes and the commit subject (gitk-style).
  const authorTexts = new Map<string, SVGTextElement>();
  let authorColumnW = 0;
  for (const n of layout.nodes) {
    const text = document.createElementNS(ns, 'text');
    text.setAttribute('class', 'graph-row-label graph-author-label');
    text.textContent = n.commit.author;
    svg.appendChild(text);
    authorColumnW = Math.max(authorColumnW, measureText(text));
    authorTexts.set(n.commit.hash, text);
  }

  const authorX = laneRight + COLUMN_GAP;
  const textX = authorX + authorColumnW + AUTHOR_GAP;
  const width = textX + SUBJECT_W + AUTHOR_PAD;
  const x = (col: number) => laneLeft + col * COL_W;
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));

  // Highlight band that follows the hovered row. Added before the edges/nodes
  // so dots, labels, and ref chips always paint on top of it.
  const hoverBand = document.createElementNS(ns, 'rect');
  hoverBand.setAttribute('x', '0');
  hoverBand.setAttribute('width', String(width));
  hoverBand.setAttribute('height', String(ROW_H));
  hoverBand.setAttribute('class', 'graph-row-hover');
  hoverBand.setAttribute('pointer-events', 'none');
  hoverBand.setAttribute('visibility', 'hidden');
  svg.appendChild(hoverBand);

  // Position the measured ref/tag chips, left-aligned in their own column.
  for (const row of refRows) {
    let chipX = LEFT_PAD;
    for (const chip of row.chips) {
      const rect = document.createElementNS(ns, 'rect');
      rect.setAttribute('x', String(chipX));
      rect.setAttribute('y', String(row.cy - CHIP_H / 2));
      rect.setAttribute('width', String(chip.width));
      rect.setAttribute('height', String(CHIP_H));
      rect.setAttribute('rx', '10');
      if (chip.isHead) {
        rect.setAttribute('fill', '#ffd54f');
      } else {
        rect.setAttribute('fill', 'none');
        rect.setAttribute('stroke', '#4a5560');
        rect.setAttribute('stroke-width', '1');
      }
      // Insert the pill underneath its text.
      svg.insertBefore(rect, chip.text);
      chip.text.setAttribute('x', String(chipX + chip.width / 2));
      chipX += chip.width + 6;
    }
  }

  // Separators: ref column | lanes | commit text | author.
  const addSep = (sx: number): void => {
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', String(sx));
    line.setAttribute('x2', String(sx));
    line.setAttribute('y1', '0');
    line.setAttribute('y2', String(height));
    line.setAttribute('stroke', 'var(--border, #3a404b)');
    line.setAttribute('stroke-width', '1');
    line.setAttribute('pointer-events', 'none');
    svg.appendChild(line);
  };
  if (refColumnW > 0) addSep(LEFT_PAD + refColumnW + REF_GAP / 2);
  addSep(laneRight + COLUMN_GAP / 2);
  addSep(authorX + authorColumnW + AUTHOR_GAP / 2);

  // --- Edges first (under dots) ---
  for (const e of layout.edges) {
    const color = laneColor(e.fromColumn);
    const x1 = x(e.fromColumn);
    const y1 = y(e.fromRow);
    const x2 = x(e.toColumn);
    const y2 = y(e.toRow);

    let d: string;
    if (e.fromColumn === e.toColumn) {
      d = `M ${x1} ${y1} L ${x2} ${y2}`;
    } else {
      // Curve into the target lane (S-curve, GitKraken style)
      const midY = (y1 + y2) / 2;
      d = `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
    }
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    path.setAttribute('stroke', color);
    path.setAttribute('stroke-width', '2.5');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke-linecap', 'round');
    svg.appendChild(path);
  }

  // --- Nodes + labels ---
  for (const n of layout.nodes) {
    const cx = x(n.column);
    const cy = y(n.row);
    const color = laneColor(n.column);

    if (n.commit.parents.length >= 2) {
      // Merge commit: ring
      const ring = document.createElementNS(ns, 'circle');
      ring.setAttribute('cx', String(cx));
      ring.setAttribute('cy', String(cy));
      ring.setAttribute('r', String(DOT_R));
      ring.setAttribute('stroke', color);
      ring.setAttribute('stroke-width', '2.5');
      ring.setAttribute('fill', 'var(--bg-graph, #1e2229)');
      ring.dataset.hash = n.commit.hash;
      svg.appendChild(ring);
    } else {
      const dot = document.createElementNS(ns, 'circle');
      dot.setAttribute('cx', String(cx));
      dot.setAttribute('cy', String(cy));
      dot.setAttribute('r', String(DOT_R));
      dot.setAttribute('fill', color);
      dot.dataset.hash = n.commit.hash;
      svg.appendChild(dot);
    }

    if (n.commit.hash === selectedHash) {
      // Selection ring: white outline around the dot / merge ring.
      const sel = document.createElementNS(ns, 'circle');
      sel.setAttribute('cx', String(cx));
      sel.setAttribute('cy', String(cy));
      sel.setAttribute('r', String(DOT_R + 3));
      sel.setAttribute('fill', 'none');
      sel.style.stroke = 'var(--sel-ring, #ffffff)';
      sel.setAttribute('stroke-width', '2');
      sel.setAttribute('pointer-events', 'none');
      svg.appendChild(sel);
    }

    // Commit subject lives in its own aligned column on the right of the lanes.
    const rowText = document.createElementNS(ns, 'text');
    rowText.setAttribute('x', String(textX));
    rowText.setAttribute('y', String(cy + 4));
    rowText.setAttribute('class', 'graph-row-label');
    rowText.dataset.hash = n.commit.hash;
    rowText.textContent = n.commit.subject;
    svg.appendChild(rowText);

    // Author in its own aligned column to the right of the subject.
    const authorText = authorTexts.get(n.commit.hash);
    if (authorText) {
      authorText.setAttribute('x', String(authorX));
      authorText.setAttribute('y', String(cy + 4));
      authorText.dataset.hash = n.commit.hash;
      // Re-append so the label paints above the hover band.
      svg.appendChild(authorText);
    }
  }

  // --- Row hover highlight ---
  hoverController?.abort();
  hoverController = new AbortController();
  const signal = hoverController.signal;
  const hideBand = (): void => {
    hoverBand.setAttribute('visibility', 'hidden');
  };
  svg.addEventListener(
    'pointermove',
    (ev) => {
      // Map the cursor to a row in the SVG's own (untransformed) coordinates.
      const box = svg.getBoundingClientRect();
      const svgH = Number(svg.getAttribute('height')) || 1;
      const localY = (ev.clientY - box.top) / (box.height / svgH);
      const row = Math.round((localY - TOP_PAD) / ROW_H);
      if (row < 0 || row >= layout.nodes.length) {
        hideBand();
        return;
      }
      hoverBand.setAttribute('y', String(y(row) - ROW_H / 2));
      hoverBand.setAttribute('visibility', 'visible');
    },
    { signal },
  );
  svg.addEventListener('pointerleave', hideBand, { signal });
}

/** Rendered width of a text node; falls back to an em estimate when not laid out. */
function measureText(el: SVGTextElement): number {
  try {
    const len = el.getComputedTextLength();
    if (len > 0) return len;
  } catch {
    // getComputedTextLength throws for elements not yet in the document.
  }
  const chars = (el.textContent ?? '').length;
  const fs = el.classList.contains('ref-chip') ? 11 : LABEL_FS;
  return chars * fs * 0.58;
}