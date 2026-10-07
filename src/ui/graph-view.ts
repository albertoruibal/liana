// Graph pane: viewport transform, header, and full/cached repaint.

import { renderDetail } from './detail';
import { $svg } from './dom';
import { updateSyncButtons } from './remotes';
import { renderSearchResults, runSearch } from './search';
import { renderStatusBar } from './status-bar';
import { StateResponse, store } from './store';
import { $ } from './dom';
import { GraphHighlight, GraphMetrics, renderGraph } from '../graph';
import { layoutGraph } from '../layout';
import { RepoState } from '../types';
import { EMPTY_METRICS } from '../graph';
export function applyTransform(): void {
  const svg = document.querySelector('#graph-svg');
  if (!(svg instanceof SVGSVGElement)) return;
  svg.style.transform = `translate(${store.panX}px, ${store.panY}px) scale(${store.zoom})`;
  svg.style.transformOrigin = '0 0';
}

/** Lay out the sticky column header to match the SVG's computed column offsets. */
export function renderGraphHeader(m: GraphMetrics): void {  const header = $('#graph-header');
  header.style.width = `${m.totalW}px`;
  const labels: Array<[number, string]> = [
    [m.refX, 'Refs'],
    [m.lanesX - 4, 'Graph'],
    [m.subjectX, 'Commit'],
  ];
  header.innerHTML = labels
    .map(([x, label]) => `<span style="left:${Math.max(0, Math.round(x))}px">${label}</span>`)
    .join('');
}

/**
 * Swap between the graph scroller and the empty-repository placeholder. An empty
 * repo has no columns to align, so the sticky header must come down with it rather
 * than pile its labels up at the left edge.
 */
export function setGraphEmpty(empty: boolean): void {
  $('#graph-empty').hidden = !empty;
  $('#graph-scroll').hidden = empty;
}

/**
 * Re-paint the graph/detail from the last fetched response without touching the
 * network. Selection and search are pure client state, so a click or keystroke
 * must never re-run the git subprocesses behind `/state`.
 */
export function renderCached(): void {
  if (store.lastResponse) renderAll(store.lastResponse);
}

export function renderAll(resp: StateResponse): void {
  store.lastResponse = resp;
  const commits = resp.commits ?? [];
  const empty = commits.length === 0;
  // Unhide the scroller before measuring, so renderGraph can size its columns to
  // the live viewport width.
  setGraphEmpty(empty);
  const layout = layoutGraph(commits);
  store.currentLayout = layout;
  const matches = runSearch(commits);
  // Resolve the focused match before drawing so its band highlights immediately.
  renderSearchResults();
  const highlight: GraphHighlight | null = store.searchQuery.trim()
    ? { matches: new Set(matches.map((m) => m.commit.hash)), current: store.searchCurrent }
    : null;
  const svg = $svg('#graph-svg');
  if (empty) {
    svg.replaceChildren();
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
  }
  const metrics = empty
    ? EMPTY_METRICS
    : renderGraph(svg, { name: store.repoName, ...resp.state } as RepoState, layout, store.selectedHash, highlight);
  renderGraphHeader(metrics);
  renderDetail(commits, resp.state, resp.status);
  updateSyncButtons();
  renderStatusBar();
}
