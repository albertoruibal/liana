// SVG rendering of the commit graph (GitKraken-like left pane).

import type { GraphLayout, RepoState } from './types';

const ROW_H = 40;
const COL_W = 28;
const DOT_R = 7;
const LABEL_FS = 12.5; // px, keep in sync with .graph-row-label in styles.css
const CHIP_H = 20;

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

export function renderGraph(svg: SVGSVGElement, _state: RepoState, layout: GraphLayout): void {
  const ns = 'http://www.w3.org/2000/svg';
  const TOP_PAD = 24;
  const LEFT_PAD = 24;
  const x = (col: number) => LEFT_PAD + col * COL_W;
  const y = (row: number) => TOP_PAD + row * ROW_H;

  const width = LEFT_PAD + layout.columns * COL_W + 600;
  const height = TOP_PAD + Math.max(1, layout.nodes.length) * ROW_H + TOP_PAD;
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.replaceChildren();

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
  // Chip geometry: measure layout first so nothing is clipped; draw later.
  interface Chip {
    x: number;
    cy: number;
    text: string;
    isHead: boolean;
  }
  const chips: Chip[] = [];

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

    const labelX = cx + DOT_R + 6;
    const rowText = document.createElementNS(ns, 'text');
    rowText.setAttribute('x', String(labelX));
    rowText.setAttribute('y', String(cy + 4));
    rowText.setAttribute('class', 'graph-row-label');
    rowText.dataset.hash = n.commit.hash;
    rowText.textContent = n.commit.subject;
    svg.appendChild(rowText);

    // Branch/tag chips, HEAD first, after the label text
    if (n.commit.refs.length > 0) {
      const sorted = [...n.commit.refs].sort((a, b) => (a === 'HEAD' ? -1 : b === 'HEAD' ? 1 : 0));
      // Approximate rendered text width: ~0.58em average per char
      const labelW = n.commit.subject.length * LABEL_FS * 0.58;
      let chipX = Math.max(labelX + labelW + 18, LEFT_PAD + layout.columns * COL_W + 70);
      for (const ref of sorted) {
        const isHead = ref === 'HEAD';
        chips.push({ x: chipX, cy, text: ref, isHead });
        chipX += ref.length * 7.5 + 22;
      }
    }
  }

  // --- Ref chips (rounded rect + centered text) ---
  for (const c of chips) {
    const w = c.text.length * 7.5 + 16;
    const rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('x', String(c.x));
    rect.setAttribute('y', String(c.cy - CHIP_H / 2));
    rect.setAttribute('width', String(w));
    rect.setAttribute('height', String(CHIP_H));
    rect.setAttribute('rx', '10');
    if (c.isHead) {
      rect.setAttribute('fill', '#ffd54f');
    } else {
      rect.setAttribute('fill', 'none');
      rect.setAttribute('stroke', '#4a5560');
      rect.setAttribute('stroke-width', '1');
    }
    svg.appendChild(rect);

    const t = document.createElementNS(ns, 'text');
    t.setAttribute('x', String(c.x + w / 2));
    t.setAttribute('y', String(c.cy + 4));
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('class', c.isHead ? 'ref-chip ref-head' : 'ref-chip');
    t.textContent = c.text;
    svg.appendChild(t);
  }
}