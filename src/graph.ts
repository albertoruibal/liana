// SVG rendering of the commit graph (left pane).

import type { GraphLayout, GraphNode, RefKind, RepoState } from './types';
import { REF_ICON_PATHS, displayRefs, type DisplayRef } from './refs';
import { isoDate, isoDateTime } from './dates';

const ROW_H = 26;
const TOP_PAD = 24;
const COL_W = 30;
const DOT_R = 7;
const LABEL_FS = 12.5; // px, keep in sync with .graph-row-label in styles.css
const CHIP_H = 21;
// Ref chip internals: leading kind icon + a little breathing room.
const ICON = 13;
const ICON_GAP = 5;
// Gap between stacked icons on a merged local+remote chip (tighter than ICON_GAP).
const ICON_STACK_GAP = 2;
const CHIP_PAD = 8;
// Maximum width of the ref column, padding included. Refs that don't fit are
// collapsed into a "+N" badge revealed on hover, so the ref column stays narrow
// and the graph lanes stay on screen regardless of how many refs a row carries.
const MAX_REF_W = 240;
const CHIP_GAP = 6;
// Gap between the lane (graph) area and the commit-text column on the right.
const COLUMN_GAP = 36;
// Gap between the ref/tag column on the left and the graph lanes.
const REF_GAP = 16;
const REF_PAD = 12;
// Fixed width reserved for the commit subject; the date/hash columns follow it.
const SUBJECT_W = 480;
// Author avatar diameter (name is shown on hover).
const AVATAR = 22;
const DATE_W = 116;
const HASH_W = 70;
const META_GAP = 20;
const META_PAD = 28;

/** One measured ref chip, shared by the visible strip and the hover cluster. */
interface Chip {
  text: SVGTextElement;
  /** Leading kind icons, left to right (empty for HEAD). */
  icons: SVGGElement[];
  isHead: boolean;
  kind: string;
  /** Ref name the context-menu actions expect (remote prefix preserved for remote-only refs). */
  name: string;
  width: number;
}

export interface GraphMetrics {
  /** Column left offsets (px from the SVG origin) for the sticky header. */
  refX: number;
  lanesX: number;
  subjectX: number;
  dateX: number;
  hashX: number;
  totalW: number;
}

/** Commits matching the active search, with the currently focused result. */
export interface GraphHighlight {
  matches: Set<string>;
  current: string | null;
}

const EMPTY_METRICS: GraphMetrics = {
  refX: 0,
  lanesX: 0,
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
  highlight: GraphHighlight | null = null,
): GraphMetrics {
  const ns = 'http://www.w3.org/2000/svg';
  const LEFT_PAD = 24;
  const y = (row: number) => TOP_PAD + row * ROW_H;

  const height = TOP_PAD + Math.max(1, layout.nodes.length) * ROW_H + TOP_PAD;
  svg.replaceChildren();

  // O(1) row lookup for the selection/search bands (was an O(n) scan per match).
  const nodeByHash = new Map<string, GraphNode>();
  for (const n of layout.nodes) nodeByHash.set(n.commit.hash, n);

  // --- Measurement pass: build the ref/tag chips and size the left column. ---
  // Chips are appended (so they get a layout box and real text length) but only
  // positioned after we know how wide the column must be.
  interface RefRow {
    row: number;
    cy: number;
    hash: string;
    chips: Chip[];
    /** Refs collapsed into the "+N" badge; empty when everything fits. */
    hidden: DisplayRef[];
    /** Width of the visible strip (incl. the "+N" badge) once positioned. */
    renderedW: number;
    /** Right x of the floating cluster once built (for hover tracking). */
    overflowRight: number;
    /** SVG group holding the hidden refs, built lazily on first reveal. */
    overflow: SVGGElement | null;
  }
  const refRows: RefRow[] = [];
  const refRowByRow = new Map<number, RefRow>();
  let maxChipRowW = 0;

  // Chip strip budget: the column width minus its padding on both sides.
  const stripBudget = Math.max(0, MAX_REF_W - REF_PAD * 2);
  for (const n of layout.nodes) {
    if (n.commit.refs.length === 0) continue;
    const cy = y(n.row);
    const sorted = displayRefs(n.commit.refs).sort((a, b) =>
      a.kind === 'head' ? -1 : b.kind === 'head' ? 1 : 0,
    );

    // Build (and measure) a chip per display ref, appended so it gets a real
    // layout box. A local branch and its remote twin share one chip with both
    // icons; remote-only refs drop the "<remote>/" prefix and keep just the icon.
    const candidates: Chip[] = sorted.map((ref) => buildRefChip(ns, svg, ref, cy, n.commit.hash));

    // Keep the longest prefix that fits the budget. When refs remain, reserve
    // a generous gap + width for the "+N" badge and shrink the prefix until both
    // fit (the badge is at most a few characters, so a fixed reserve suffices).
    const badgeReserve = CHIP_GAP + CHIP_PAD * 2 + 30;
    const stripW = (upto: number): number => {
      let w = 0;
      for (let i = 0; i < upto; i++) w += candidates[i]!.width + CHIP_GAP;
      return w > 0 ? w - CHIP_GAP : 0;
    };
    let keep = candidates.length;
    while (keep > 0 && stripW(keep) > stripBudget) keep -= 1;
    if (keep < candidates.length) {
      while (keep > 0 && stripW(keep) + badgeReserve > stripBudget) keep -= 1;
    }
    // A lone chip wider than the whole cap: truncate its label with an ellipsis
    // (full name stays in the tooltip and dataset) so the cap is always honored.
    // Leave room for the "+N" badge when other refs still need collapsing.
    if (keep === 0 && candidates.length > 0) {
      const first = candidates[0]!;
      const iconW = iconBlockWidth(first.icons.length);
      const reserve = candidates.length > 1 ? badgeReserve : 0;
      const labelW = Math.max(0, stripBudget - reserve - CHIP_PAD * 2 - iconW);
      first.text.textContent = fitText(first.text, first.name, labelW);
      first.width = measureText(first.text, first.text.textContent ?? '') + CHIP_PAD * 2 + iconW;
      const title = document.createElementNS(ns, 'title');
      title.textContent = first.name;
      first.text.appendChild(title);
      keep = 1;
    }

    // Drop the candidates that didn't make the cut; the hover cluster rebuilds
    // their chips from `row.hidden` on first reveal.
    for (const c of candidates.slice(keep)) {
      for (const icon of c.icons) icon.remove();
      c.text.remove();
    }

    const chips = candidates.slice(0, keep);
    let rowW = stripW(keep);
    const hidden = sorted.slice(keep);
    if (hidden.length > 0) {
      const badge = document.createElementNS(ns, 'text');
      badge.setAttribute('y', String(cy + 4));
      badge.setAttribute('text-anchor', 'start');
      badge.setAttribute('class', 'ref-chip ref-chip-overflow');
      badge.dataset.hash = n.commit.hash; // commit menu, not a tag menu
      badge.textContent = `+${hidden.length}`;
      svg.appendChild(badge);
      const width = measureText(badge, badge.textContent ?? '') + CHIP_PAD * 2;
      chips.push({ text: badge, icons: [], isHead: false, kind: 'overflow', name: '', width });
      rowW += CHIP_GAP + width;
    }
    if (rowW > 0) maxChipRowW = Math.max(maxChipRowW, rowW);
    const row: RefRow = {
      row: n.row,
      cy,
      hash: n.commit.hash,
      chips,
      hidden,
      renderedW: 0,
      overflowRight: 0,
      overflow: null,
    };
    refRows.push(row);
    refRowByRow.set(n.row, row);
  }

  // Left column width (chips + padding), 0 when the repo has no refs.
  const refColumnW = maxChipRowW > 0 ? maxChipRowW + REF_PAD * 2 : 0;
  const laneLeft = refColumnW > 0 ? LEFT_PAD + refColumnW + REF_GAP : LEFT_PAD;
  const laneRight = laneLeft + layout.columns * COL_W;

  // Column x offsets. The subject column flexes to fill whatever space the
  // scroll viewport leaves, so the date/hash columns stay on screen. The author
  // avatar occupies the first AVATAR+8 px of the commit column; the subject text
  // starts just after it.
  const refX = LEFT_PAD;
  const subjectX = laneRight + COLUMN_GAP;
  const authorTextX = subjectX + AVATAR + 8;
  const fixedW = authorTextX + META_GAP + DATE_W + META_GAP + HASH_W + META_PAD;
  const viewportW = svg.closest('#graph-scroll')?.clientWidth ?? 0;
  const subjectW =
    viewportW > 0 ? Math.max(160, Math.min(SUBJECT_W, viewportW - fixedW)) : SUBJECT_W;
  const dateX = subjectX + subjectW + META_GAP;
  const hashX = dateX + DATE_W + META_GAP;
  const hashRight = hashX + HASH_W;
  const width = hashRight + META_PAD;
  const x = (col: number) => laneLeft + col * COL_W;
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));

  // Persistent tint for the selected row, under everything else.
  if (selectedHash) {
    const selNode = nodeByHash.get(selectedHash);
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

  // Tint every search match, with a stronger marker for the focused result.
  // Painted under the edges/nodes so the graph stays legible.
  if (highlight && highlight.matches.size > 0) {
    const addMatchBand = (hash: string, current: boolean): void => {
      const node = nodeByHash.get(hash);
      if (!node) return;
      const band = document.createElementNS(ns, 'rect');
      band.setAttribute('x', '0');
      band.setAttribute('y', String(y(node.row) - ROW_H / 2));
      band.setAttribute('width', String(width));
      band.setAttribute('height', String(ROW_H));
      band.setAttribute('class', current ? 'graph-row-match is-current' : 'graph-row-match');
      band.setAttribute('pointer-events', 'none');
      svg.appendChild(band);
    };
    for (const hash of highlight.matches) {
      if (hash !== highlight.current) addMatchBand(hash, false);
    }
    if (highlight.current && highlight.matches.has(highlight.current)) {
      addMatchBand(highlight.current, true);
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
      placeChip(ns, svg, chip, chipX, row.cy);
      chipX += chip.width + CHIP_GAP;
    }
    row.renderedW = row.chips.length > 0 ? chipX - CHIP_GAP - refX : 0;
  }

  // Build (once) the floating cluster of refs hidden behind a row's "+N" badge.
  // Kept out of the layout pass: it is appended on reveal, so it paints above
  // the edges, row bands, and full-width row hit rectangles.
  const buildOverflow = (row: RefRow): void => {
    const g = document.createElementNS(ns, 'g') as SVGGElement;
    g.setAttribute('class', 'ref-overflow-group');
    // Attach before measuring: a detached element has no layout box, so
    // getComputedTextLength() would fall back to a rough em estimate and the
    // pills would end up wider than their labels. Hidden once placed.
    svg.appendChild(g);
    const startX = refX + row.renderedW + CHIP_PAD;
    const built: Chip[] = row.hidden.map((ref) => buildRefChip(ns, g, ref, row.cy, row.hash));
    let chipX = startX;
    for (const chip of built) {
      placeChip(ns, g, chip, chipX, row.cy);
      chipX += chip.width + CHIP_GAP;
    }
    // Soft panel behind the cluster so overlapped lanes stay legible.
    const bg = document.createElementNS(ns, 'rect');
    bg.setAttribute('x', String(startX - CHIP_PAD / 2));
    bg.setAttribute('y', String(row.cy - CHIP_H / 2 - 4));
    bg.setAttribute('width', String(chipX - CHIP_GAP + CHIP_PAD / 2 - startX));
    bg.setAttribute('height', String(CHIP_H + 8));
    bg.setAttribute('rx', '7');
    bg.setAttribute('class', 'ref-overflow-bg');
    g.insertBefore(bg, g.firstChild);
    g.style.display = 'none';
    row.overflow = g;
    row.overflowRight = chipX - CHIP_GAP;
  };

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

    // Commit subject lives in its own aligned column; clip with an ellipsis so
    // long subjects never bleed into the date column.
    const rowText = document.createElementNS(ns, 'text');
    rowText.setAttribute('x', String(authorTextX));
    rowText.setAttribute('y', String(cy + 4));
    rowText.setAttribute('class', 'graph-row-label');
    rowText.dataset.hash = n.commit.hash;
    rowText.textContent = n.commit.subject;
    svg.appendChild(rowText);
    rowText.textContent = fitText(rowText, n.commit.subject, subjectW - AVATAR - 20);

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
    hashText.textContent = n.commit.hash.slice(0, 8);
    svg.appendChild(hashText);
  }

  // --- Full-width row hit targets ---
  // One transparent rect per row, painted on top of the edges/labels so a click
  // anywhere on the row selects the commit. `pointer-events: fill` makes the
  // transparent fill receive clicks while leaving the graph visible. Start after
  // the ref column so branch/tag chips keep their own right-click context menu.
  const hitLeft = refColumnW > 0 ? laneLeft - REF_GAP / 2 : 0;
  for (const n of layout.nodes) {
    const hit = document.createElementNS(ns, 'rect');
    hit.setAttribute('x', String(hitLeft));
    hit.setAttribute('y', String(y(n.row) - ROW_H / 2));
    hit.setAttribute('width', String(width - hitLeft));
    hit.setAttribute('height', String(ROW_H));
    hit.setAttribute('class', 'graph-row-hit');
    hit.dataset.hash = n.commit.hash;
    svg.appendChild(hit);
  }

  // Author avatars, painted above the row hit targets so their <title> tooltips
  // fire on hover (and the circles stay right-clickable); the rect beneath still
  // handles clicks on the rest of the row. The name is only revealed on hover.
  for (const n of layout.nodes) {
    const ax = subjectX;
    const cy = y(n.row);
    const avatar = document.createElementNS(ns, 'circle');
    avatar.setAttribute('cx', String(ax + AVATAR / 2));
    avatar.setAttribute('cy', String(cy));
    avatar.setAttribute('r', String(AVATAR / 2));
    avatar.setAttribute('fill', avatarColor(n.commit.author));
    avatar.setAttribute('opacity', '0.9');
    avatar.dataset.hash = n.commit.hash;

    const avatarTitle = document.createElementNS(ns, 'title');
    avatarTitle.textContent = n.commit.author;
    avatar.appendChild(avatarTitle);

    const avText = document.createElementNS(ns, 'text');
    avText.setAttribute('x', String(ax + AVATAR / 2));
    avText.setAttribute('y', String(cy + 3.5));
    avText.setAttribute('text-anchor', 'middle');
    avText.setAttribute('class', 'graph-avatar-text');
    avText.setAttribute('fill', '#0d0b16');
    avText.textContent = initials(n.commit.author);

    svg.appendChild(avatar);
    svg.appendChild(avText);
  }

  // --- Row hover highlight ---
  hoverController?.abort();
  hoverController = new AbortController();
  const signal = hoverController.signal;
  // The overflow cluster reveals while the pointer is over its row's ref column
  // (or over the open cluster itself, so a hidden tag can be right-clicked).
  let openOverflow: RefRow | null = null;
  const hideBand = (): void => {
    hoverBand.setAttribute('visibility', 'hidden');
  };
  const hideOverflow = (): void => {
    if (!openOverflow) return;
    openOverflow.overflow?.style.setProperty('display', 'none');
    openOverflow = null;
  };
  svg.addEventListener(
    'pointermove',
    (ev) => {
      // Map the cursor to a row in the SVG's own (untransformed) coordinates.
      const box = svg.getBoundingClientRect();
      const svgH = Number(svg.getAttribute('height')) || 1;
      const svgW = Number(svg.getAttribute('width')) || 1;
      const scale = box.height / svgH;
      const localY = (ev.clientY - box.top) / scale;
      const localX = (ev.clientX - box.left) / (box.width / svgW);
      const row = Math.round((localY - TOP_PAD) / ROW_H);
      if (row < 0 || row >= layout.nodes.length) {
        hideBand();
        hideOverflow();
        return;
      }
      hoverBand.setAttribute('y', String(y(row) - ROW_H / 2));
      hoverBand.setAttribute('visibility', 'visible');

      // The cluster is only shown over the ref column; once open it stays open
      // across its whole width so a hidden tag can be reached and right-clicked.
      const target = refRowByRow.get(row);
      const overCluster =
        openOverflow !== null &&
        openOverflow.row === row &&
        localX <= openOverflow.overflowRight + 8;
      const inRefBand = localX >= refX - CHIP_PAD && localX <= laneLeft - REF_GAP / 2;
      if (target && target.hidden.length > 0 && (inRefBand || overCluster)) {
        if (openOverflow !== target) {
          hideOverflow();
          if (!target.overflow) buildOverflow(target);
          target.overflow?.style.setProperty('display', '');
          openOverflow = target;
        }
      } else {
        hideOverflow();
      }
    },
    { signal },
  );
  const onLeave = (): void => {
    hideBand();
    hideOverflow();
  };
  svg.addEventListener('pointerleave', onLeave, { signal });

  return { refX, lanesX: laneLeft, subjectX, dateX, hashX, totalW: width };
}

/**
 * Draw one chip (pill + leading icon(s) + label) into `root`, left edge at `x`,
 * vertically centered on `cy`. Shared by the visible strip and the overflow
 * cluster, which lives in its own `<g>`.
 */
function placeChip(
  ns: string,
  root: SVGElement,
  chip: { text: SVGTextElement; icons: SVGGElement[]; isHead: boolean; kind: string; name: string; width: number },
  x: number,
  cy: number,
): void {
  const rect = document.createElementNS(ns, 'rect') as SVGRectElement;
  rect.setAttribute('x', String(x));
  rect.setAttribute('y', String(cy - CHIP_H / 2));
  rect.setAttribute('width', String(chip.width));
  rect.setAttribute('height', String(CHIP_H));
  rect.setAttribute('rx', String(CHIP_H / 2));
  if (chip.kind !== 'overflow') {
    rect.dataset.kind = chip.kind;
    rect.dataset.name = chip.name;
  }
  rect.dataset.hash = chip.text.dataset.hash ?? '';
  applyChipStyle(rect, chip.kind, chip.isHead);
  // Insert the pill underneath its icons and text.
  root.insertBefore(rect, chip.icons[0] ?? chip.text);
  const iconX = x + CHIP_PAD;
  if (chip.icons.length === 0) {
    chip.text.setAttribute('x', String(iconX));
    return;
  }
  let ix = iconX;
  for (const icon of chip.icons) {
    icon.setAttribute('transform', `translate(${ix} ${cy - ICON / 2})`);
    ix += ICON + ICON_STACK_GAP;
  }
  const textX = ix - ICON_STACK_GAP + ICON_GAP;
  chip.text.setAttribute('x', String(textX));
}

/** Build and measure a display ref chip, appending its icon(s) and text to `root`. */
function buildRefChip(ns: string, root: SVGElement, ref: DisplayRef, cy: number, hash: string): Chip {
  const isHead = ref.kind === 'head';
  const icons: SVGGElement[] = [];
  for (const kind of ref.icons) {
    const icon = createRefIcon(ns, kind);
    if (!icon) continue;
    icon.dataset.kind = ref.kind;
    icon.dataset.name = ref.menuName;
    icon.dataset.hash = hash;
    root.appendChild(icon);
    icons.push(icon);
  }
  const text = document.createElementNS(ns, 'text') as SVGTextElement;
  text.setAttribute('y', String(cy + 4));
  text.setAttribute('text-anchor', 'start');
  text.setAttribute('class', isHead ? 'ref-chip ref-head' : `ref-chip ref-${ref.kind}`);
  text.dataset.kind = ref.kind;
  text.dataset.name = ref.menuName;
  text.dataset.hash = hash;
  text.textContent = ref.name;
  // Keep the full (unmerged) label — remote prefix included — in the tooltip.
  const title = document.createElementNS(ns, 'title');
  title.textContent = ref.title;
  text.appendChild(title);
  root.appendChild(text);
  const width = measureText(text, ref.name) + CHIP_PAD * 2 + iconBlockWidth(icons.length);
  return { text, icons, isHead, kind: ref.kind, name: ref.menuName, width };
}

/** Width of the leading icon block plus the gap before the label. */
function iconBlockWidth(count: number): number {
  if (count <= 0) return 0;
  return count * ICON + (count - 1) * ICON_STACK_GAP + ICON_GAP;
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
    overflow: '164, 157, 192',
  };
  const rgb = tones[kind] ?? '164, 157, 192';
  rect.setAttribute('fill', `rgba(${rgb}, 0.12)`);
  rect.setAttribute('stroke', `rgba(${rgb}, 0.5)`);
  rect.setAttribute('stroke-width', '1');
}

/** Truncate `text` to fit `maxW` px, appending an ellipsis when clipped. */
function fitText(el: SVGTextElement, text: string, maxW: number): string {
  const measure = (s: string): number => measureText(el, s);
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

// Reusable 2D context for text metrics. `getComputedTextLength()` forces a
// synchronous layout per call (hundreds of times per render); canvas metrics are
// layout-free. Fonts are resolved once per class and cached.
let measureCtx: CanvasRenderingContext2D | null | undefined;
const fontCache = new Map<string, string>();

function canvasFont(el: SVGTextElement): string {
  const key =
    el.classList.contains('ref-chip') ? 'chip' : el.classList.contains('graph-meta-label') ? 'meta' : 'label';
  const cached = fontCache.get(key);
  if (cached) return cached;
  let font = '12.5px sans-serif';
  try {
    const cs = getComputedStyle(el);
    const weight = cs.fontWeight || '400';
    const size = cs.fontSize || '12.5px';
    const family = cs.fontFamily || 'sans-serif';
    font = `${weight} ${size} ${family}`;
  } catch {
    // Element not in the document yet; keep the fallback.
  }
  fontCache.set(key, font);
  return font;
}

/**
 * Rendered width of `text` when drawn with `el`'s font. Prefers canvas metrics so
 * measuring never forces layout; falls back to `getComputedTextLength`, then an
 * em estimate, when a canvas context is unavailable.
 */
function measureText(el: SVGTextElement, text: string): number {
  if (measureCtx === undefined) {
    measureCtx =
      typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
  }
  if (measureCtx) {
    measureCtx.font = canvasFont(el);
    return measureCtx.measureText(text).width;
  }
  const prev = el.textContent;
  el.textContent = text;
  try {
    const len = el.getComputedTextLength();
    if (len > 0) return len;
  } catch {
    // getComputedTextLength throws for elements not yet in the document.
  } finally {
    el.textContent = prev;
  }
  const fs = el.classList.contains('ref-chip') ? 11 : LABEL_FS;
  return text.length * fs * 0.58;
}

export { EMPTY_METRICS };
