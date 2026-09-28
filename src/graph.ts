// SVG rendering of the commit graph (left pane).

import type { GraphLayout, RefKind, RepoState } from './types';
import { REF_ICON_PATHS } from './refs';
import { isoDate, isoDateTime } from './dates';

const ROW_H = 42;
const COL_W = 30;
const DOT_R = 7;
const LABEL_FS = 12.5; // px, keep in sync with .graph-row-label in styles.css
const CHIP_H = 21;
// Ref chip internals: leading kind icon + a little breathing room.
const ICON = 13;
const ICON_GAP = 5;
const CHIP_PAD = 8;
// Gap between the lane (graph) area and the commit-text column on the right.
const COLUMN_GAP = 36;
// Gap between the ref/tag column on the left and the graph lanes.
const REF_GAP = 16;
const REF_PAD = 12;
// Fixed width reserved for the commit subject; the date/hash columns follow it.
const SUBJECT_W = 480;
// Author avatar + name column.
const AVATAR = 22;
const AUTHOR_GAP = 18;
const DATE_W = 116;
const HASH_W = 64;
const META_GAP = 20;
const META_PAD = 28;

export interface GraphMetrics {
  /** Column left offsets (px from the SVG origin) for the sticky header. */
  refX: number;
  lanesX: number;
  authorX: number;
  subjectX: number;
  dateX: number;
  hashX: number;
  totalW: number;
}

const EMPTY_METRICS: GraphMetrics = {
  refX: 0,
  lanesX: 0,
  authorX: 0,
  subjectX: 0,
  dateX: 0,
  hashX: 0,
  totalW: 0,
};

// Lane palette: violet / cyan / rose / teal / amber / indigo …
const COLORS = [
  '#a78bfa', // violet
  '#22d3ee', // cyan
  '#fb7185', // rose
  '#2dd4bf', // teal
  '#fbbf24', // amber
  '#818cf8', // indigo
  '#f472b6', // pink
  '#4ade80', // green
  '#60a5fa', // blue
  '#fb923c', // orange
];

export function laneColor(col: number): string {
  return COLORS[col % COLORS.length]!;
}

// Deterministic avatar tint from a name, drawn from the same palette family.
const AVATAR_COLORS = [
  '#a78bfa',
  '#22d3ee',
  '#fb7185',
  '#2dd4bf',
  '#fbbf24',
  '#818cf8',
  '#f472b6',
  '#4ade80',
];

/** First letters of a name, e.g. "Ada Lovelace" -> "AL". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '?';
  const last = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? '' : '';
  return (first + last).toUpperCase();
}

/** Stable colour for an author's avatar. */
export function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length]!;
}

let hoverController: AbortController | null = null;

export function renderGraph(
  svg: SVGSVGElement,
  _state: RepoState,
  layout: GraphLayout,
  selectedHash: string | null = null,
): GraphMetrics {
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
    icon: SVGGElement | null;
    isHead: boolean;
    kind: string;
    name: string;
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
    const sorted = [...n.commit.refs].sort((a, b) =>
      a.kind === 'head' ? -1 : b.kind === 'head' ? 1 : 0,
    );
    const chips: Chip[] = [];
    let rowW = 0;
    for (const ref of sorted) {
      const isHead = ref.kind === 'head';
      const icon = createRefIcon(ns, ref.kind);
      if (icon) {
        icon.dataset.name = ref.name;
        icon.dataset.hash = n.commit.hash;
        svg.appendChild(icon);
      }
      const text = document.createElementNS(ns, 'text');
      text.setAttribute('y', String(cy + 4));
      text.setAttribute('text-anchor', 'start');
      text.setAttribute('class', isHead ? 'ref-chip ref-head' : `ref-chip ref-${ref.kind}`);
      text.dataset.kind = ref.kind;
      text.dataset.name = ref.name;
      text.dataset.hash = n.commit.hash;
      text.textContent = ref.name;
      svg.appendChild(text);
      const iconW = icon ? ICON + ICON_GAP : 0;
      const width = measureText(text) + CHIP_PAD * 2 + iconW;
      chips.push({ text, icon, isHead, kind: ref.kind, name: ref.name, width });
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
  const authorTexts = new Map<string, SVGTextElement>();
  let authorNameW = 0;
  for (const n of layout.nodes) {
    const text = document.createElementNS(ns, 'text');
    text.setAttribute('class', 'graph-row-label graph-author-label');
    text.textContent = n.commit.author;
    svg.appendChild(text);
    authorNameW = Math.max(authorNameW, measureText(text));
    authorTexts.set(n.commit.hash, text);
  }
  const authorColumnW = AVATAR + 8 + authorNameW;

  // Column x offsets. The subject column flexes to fill whatever space the
  // scroll viewport leaves, so the date/hash columns stay on screen.
  const refX = LEFT_PAD;
  const authorX = laneRight + COLUMN_GAP;
  const fixedW =
    authorX +
    authorColumnW +
    AUTHOR_GAP +
    META_GAP +
    DATE_W +
    META_GAP +
    HASH_W +
    META_PAD;
  const viewportW = svg.closest('#graph-scroll')?.clientWidth ?? 0;
  const subjectW =
    viewportW > 0 ? Math.max(160, Math.min(SUBJECT_W, viewportW - fixedW)) : SUBJECT_W;
  const subjectX = authorX + authorColumnW + AUTHOR_GAP;
  const dateX = subjectX + subjectW + META_GAP;
  const hashX = dateX + DATE_W + META_GAP;
  const hashRight = hashX + HASH_W;
  const width = hashRight + META_PAD;
  const x = (col: number) => laneLeft + col * COL_W;
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));

  // Persistent tint for the selected row, under everything else.
  if (selectedHash) {
    const selNode = layout.nodes.find((n) => n.commit.hash === selectedHash);
    if (selNode) {
      const selBand = document.createElementNS(ns, 'rect');
      selBand.setAttribute('x', '0');
      selBand.setAttribute('y', String(y(selNode.row) - ROW_H / 2));
      selBand.setAttribute('width', String(width));
      selBand.setAttribute('height', String(ROW_H));
      selBand.setAttribute('class', 'graph-row-selected');
      selBand.setAttribute('pointer-events', 'none');
      svg.appendChild(selBand);
    }
  }

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
    let chipX = refX;
    for (const chip of row.chips) {
      const rect = document.createElementNS(ns, 'rect');
      rect.setAttribute('x', String(chipX));
      rect.setAttribute('y', String(row.cy - CHIP_H / 2));
      rect.setAttribute('width', String(chip.width));
      rect.setAttribute('height', String(CHIP_H));
      rect.setAttribute('rx', String(CHIP_H / 2));
      rect.dataset.kind = chip.kind;
      rect.dataset.name = chip.name;
      rect.dataset.hash = chip.text.dataset.hash ?? '';
      applyChipStyle(rect, chip.kind, chip.isHead);
      // Insert the pill underneath its icon and text.
      svg.insertBefore(rect, chip.icon ?? chip.text);
      const iconX = chipX + CHIP_PAD;
      const textX = iconX + (chip.icon ? ICON + ICON_GAP : 0);
      if (chip.icon) {
        chip.icon.setAttribute(
          'transform',
          `translate(${iconX} ${row.cy - ICON / 2})`,
        );
      }
      chip.text.setAttribute('x', String(textX));
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
    line.setAttribute('stroke', 'var(--border-soft, #221c37)');
    line.setAttribute('stroke-width', '1');
    line.setAttribute('pointer-events', 'none');
    svg.appendChild(line);
  };
  if (refColumnW > 0) addSep(laneLeft - REF_GAP / 2);
  addSep(laneRight + COLUMN_GAP / 2);
  addSep(subjectX - AUTHOR_GAP / 2);

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
      // Curve into the target lane (S-curve)
      const midY = (y1 + y2) / 2;
      d = `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
    }
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    path.setAttribute('stroke', color);
    path.setAttribute('stroke-width', '2.75');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('opacity', e.merge ? '0.7' : '0.95');
    svg.appendChild(path);
  }

  // --- Nodes + labels ---

  for (const n of layout.nodes) {
    const cx = x(n.column);
    const cy = y(n.row);
    const color = laneColor(n.column);

    // Soft halo behind the node for a lit-from-within look.
    const halo = document.createElementNS(ns, 'circle');
    halo.setAttribute('cx', String(cx));
    halo.setAttribute('cy', String(cy));
    halo.setAttribute('r', String(DOT_R + 3));
    halo.setAttribute('fill', color);
    halo.setAttribute('opacity', '0.18');
    halo.setAttribute('pointer-events', 'none');
    svg.appendChild(halo);

    if (n.commit.parents.length >= 2) {
      // Merge commit: ring
      const ring = document.createElementNS(ns, 'circle');
      ring.setAttribute('cx', String(cx));
      ring.setAttribute('cy', String(cy));
      ring.setAttribute('r', String(DOT_R));
      ring.setAttribute('stroke', color);
      ring.setAttribute('stroke-width', '2.5');
      ring.setAttribute('fill', 'var(--bg-graph, #110e1d)');
      ring.dataset.hash = n.commit.hash;
      svg.appendChild(ring);

      const core = document.createElementNS(ns, 'circle');
      core.setAttribute('cx', String(cx));
      core.setAttribute('cy', String(cy));
      core.setAttribute('r', '2.4');
      core.setAttribute('fill', color);
      core.setAttribute('pointer-events', 'none');
      svg.appendChild(core);
    } else {
      const dot = document.createElementNS(ns, 'circle');
      dot.setAttribute('cx', String(cx));
      dot.setAttribute('cy', String(cy));
      dot.setAttribute('r', String(DOT_R));
      dot.setAttribute('fill', color);
      dot.setAttribute('stroke', 'var(--bg-graph, #110e1d)');
      dot.setAttribute('stroke-width', '1.5');
      dot.dataset.hash = n.commit.hash;
      svg.appendChild(dot);
    }

    if (n.commit.hash === selectedHash) {
      // Selection ring around the dot / merge ring.
      const sel = document.createElementNS(ns, 'circle');
      sel.setAttribute('cx', String(cx));
      sel.setAttribute('cy', String(cy));
      sel.setAttribute('r', String(DOT_R + 3.5));
      sel.setAttribute('class', 'graph-node-selected');
      sel.setAttribute('pointer-events', 'none');
      svg.appendChild(sel);
    }

    // Author avatar + name.
    const ax = authorX;
    const avatar = document.createElementNS(ns, 'circle');
    avatar.setAttribute('cx', String(ax + AVATAR / 2));
    avatar.setAttribute('cy', String(cy));
    avatar.setAttribute('r', String(AVATAR / 2));
    avatar.setAttribute('fill', avatarColor(n.commit.author));
    avatar.setAttribute('opacity', '0.9');
    avatar.dataset.hash = n.commit.hash;
    svg.appendChild(avatar);

    const avText = document.createElementNS(ns, 'text');
    avText.setAttribute('x', String(ax + AVATAR / 2));
    avText.setAttribute('y', String(cy + 3.5));
    avText.setAttribute('text-anchor', 'middle');
    avText.setAttribute('class', 'graph-avatar-text');
    avText.setAttribute('fill', '#0d0b16');
    avText.textContent = initials(n.commit.author);
    svg.appendChild(avText);

    // Commit subject lives in its own aligned column; clip with an ellipsis so
    // long subjects never bleed into the date column.
    const rowText = document.createElementNS(ns, 'text');
    rowText.setAttribute('x', String(subjectX));
    rowText.setAttribute('y', String(cy + 4));
    rowText.setAttribute('class', 'graph-row-label');
    rowText.dataset.hash = n.commit.hash;
    rowText.textContent = n.commit.subject;
    svg.appendChild(rowText);
    rowText.textContent = fitText(rowText, n.commit.subject, subjectW - 12);

    // Date column (ISO calendar day in local time; full stamp in the title).
    const dateText = document.createElementNS(ns, 'text');
    dateText.setAttribute('x', String(dateX));
    dateText.setAttribute('y', String(cy + 4));
    dateText.setAttribute('class', 'graph-meta-label');
    dateText.textContent = isoDate(n.commit.timestamp);
    dateText.dataset.hash = n.commit.hash;
    const title = document.createElementNS(ns, 'title');
    title.textContent = isoDateTime(n.commit.timestamp);
    dateText.appendChild(title);
    svg.appendChild(dateText);

    // Short hash column.
    const hashText = document.createElementNS(ns, 'text');
    hashText.setAttribute('x', String(hashX));
    hashText.setAttribute('y', String(cy + 4));
    hashText.setAttribute('class', 'graph-meta-label graph-hash');
    hashText.dataset.hash = n.commit.hash;
    hashText.textContent = n.commit.hash.slice(0, 7);
    svg.appendChild(hashText);

    // Author name (measured earlier), re-appended to paint above the bands.
    const authorText = authorTexts.get(n.commit.hash);
    if (authorText) {
      authorText.setAttribute('x', String(ax + AVATAR + 8));
      authorText.setAttribute('y', String(cy + 4));
      authorText.dataset.hash = n.commit.hash;
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

  return { refX, lanesX: laneLeft, authorX, subjectX, dateX, hashX, totalW: width };
}

/** Build the small kind icon that sits at the left of a ref chip. */
function createRefIcon(ns: string, kind: RefKind): SVGGElement | null {
  const paths = REF_ICON_PATHS[kind];
  if (paths.length === 0) return null;
  const group = document.createElementNS(ns, 'g') as SVGGElement;
  group.setAttribute('class', `ref-chip-icon ref-chip-icon-${kind}`);
  group.setAttribute('pointer-events', 'none');
  for (const d of paths) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    group.appendChild(path);
  }
  return group;
}

/** Apply the kind-specific chip fill/stroke. */
function applyChipStyle(rect: SVGElement, kind: string, isHead: boolean): void {
  if (isHead) {
    rect.setAttribute('fill', 'var(--head, #fbbf24)');
    rect.setAttribute('stroke', 'none');
    return;
  }
  const tones: Record<string, string> = {
    local: '167, 139, 250',
    remote: '34, 211, 238',
    tag: '251, 191, 36',
    stash: '244, 114, 182',
  };
  const rgb = tones[kind] ?? '164, 157, 192';
  rect.setAttribute('fill', `rgba(${rgb}, 0.12)`);
  rect.setAttribute('stroke', `rgba(${rgb}, 0.5)`);
  rect.setAttribute('stroke-width', '1');
}

/** Truncate `text` to fit `maxW` px, appending an ellipsis when clipped. */
function fitText(el: SVGTextElement, text: string, maxW: number): string {
  const measure = (s: string): number => {
    el.textContent = s;
    return measureText(el);
  };
  if (measure(text) <= maxW) return text;
  const ellipsis = '\u2026';
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(text.slice(0, mid) + ellipsis) <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? text.slice(0, lo) + ellipsis : ellipsis;
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

export { EMPTY_METRICS };
