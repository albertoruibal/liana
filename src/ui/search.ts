// Search over commits, branches, and tags.

import { esc } from './format';
import { renderCached } from './graph-view';
import { $, isTypingTarget } from './dom';
import { store } from './store';
import { isoDate } from '../dates';
import { GitCommit, GitRef } from '../types';

// --- Search: commits, branches, and tags ---
/** A commit that matched the active query, with the fields that matched. */
export interface SearchMatch {
  commit: GitCommit;
  /** Human labels for what matched: "subject", "author", "branch main", "tag v1.0", … */
  fields: string[];
}

/** Human label for a ref: distinguishes branches from tags and stashes. */
export function refSearchLabel(ref: GitRef): string {
  switch (ref.kind) {
    case 'local':
      return `branch ${ref.name}`;
    case 'remote':
      return `remote branch ${ref.name}`;
    case 'tag':
      return `tag ${ref.name}`;
    case 'stash':
      return `stash ${ref.name}`;
    default:
      return ref.name;
  }
}

/** True when a ref name (branch/tag/stash) matches every query token. */
export function refMatches(ref: GitRef, tokens: string[]): boolean {
  const name = ref.name.toLowerCase();
  return tokens.every((t) => name.includes(t));
}

/**
 * Filter `commits` by the active query. Every whitespace-separated token must
 * match somewhere (AND); matching is case-insensitive across subject, author,
 * hash, and ref names — local branches, remote branches, tags, and stashes.
 */
export function runSearch(commits: GitCommit[]): SearchMatch[] {
  const q = store.searchQuery.trim().toLowerCase();
  if (!q) {
    store.searchMatches = [];
    store.searchCurrent = null;
    return store.searchMatches;
  }
  const tokens = q.split(/\s+/).filter(Boolean);
  const matches: SearchMatch[] = [];
  for (const commit of commits) {
    const fields: string[] = [];
    if (tokens.every((t) => commit.subject.toLowerCase().includes(t))) fields.push('subject');
    if (tokens.every((t) => commit.author.toLowerCase().includes(t))) fields.push('author');
    if (tokens.every((t) => commit.hash.toLowerCase().includes(t))) fields.push('hash');
    for (const ref of commit.refs) {
      if (!refMatches(ref, tokens)) continue;
      fields.push(refSearchLabel(ref));
    }
    if (commit.stash) {
      const haystack = `${commit.stash.message} ${commit.stash.branch ?? ''}`.toLowerCase();
      if (tokens.every((t) => haystack.includes(t))) fields.push('stash');
    }
    if (fields.length > 0) matches.push({ commit, fields: [...new Set(fields)] });
  }
  store.searchMatches = matches;
  return matches;
}

/** Scroll the graph so the row for `hash` is centered in the viewport. */
export function scrollToHash(hash: string): void {
  const scroller = document.querySelector('#graph-scroll');
  if (!(scroller instanceof HTMLElement)) return;
  const hit = document.querySelector(`#graph-svg rect.graph-row-hit[data-hash="${hash}"]`);
  if (!(hit instanceof SVGRectElement)) return;
  const scrollerRect = scroller.getBoundingClientRect();
  const hitRect = hit.getBoundingClientRect();
  if (hitRect.top >= scrollerRect.top && hitRect.bottom <= scrollerRect.bottom) return;
  const delta = hitRect.top - scrollerRect.top - (scrollerRect.height - hitRect.height) / 2;
  scroller.scrollBy({ top: delta, behavior: 'smooth' });
}

/** Select a search result, reload the view, and bring its row into sight. */
export function focusMatch(hash: string): void {
  store.searchCurrent = hash;
  store.selectedHash = hash;
  renderCached();
  scrollToHash(hash);
}

/** Move the focused match by `delta` (wrapping), then focus it. */
export function searchStep(delta: number): void {
  if (store.searchMatches.length === 0) return;
  const idx = store.searchMatches.findIndex((m) => m.commit.hash === store.searchCurrent);
  const next =
    idx === -1
      ? delta > 0
        ? 0
        : store.searchMatches.length - 1
      : (idx + delta + store.searchMatches.length) % store.searchMatches.length;
  const match = store.searchMatches[next];
  if (match) focusMatch(match.commit.hash);
}

/** Render the results list and the "n/total" counter for the current query. */
export function renderSearchResults(): void {
  const list = $('#search-results');
  const count = $('#search-count');
  if (!store.searchQuery.trim()) {
    list.replaceChildren();
    count.textContent = '';
    return;
  }
  if (store.searchMatches.length === 0) {
    list.innerHTML = '<li class="search-empty muted">No commits or tags match.</li>';
    count.textContent = '0/0';
    return;
  }
  if (!store.searchCurrent || !store.searchMatches.some((m) => m.commit.hash === store.searchCurrent)) {
    store.searchCurrent = store.searchMatches[0]?.commit.hash ?? null;
  }
  const idx = store.searchMatches.findIndex((m) => m.commit.hash === store.searchCurrent);
  count.textContent = `${idx + 1}/${store.searchMatches.length}`;
  list.replaceChildren(
    ...store.searchMatches.map((m, i) => {
      const li = document.createElement('li');
      li.className = `search-result${i === idx ? ' is-current' : ''}`;
      li.dataset.hash = m.commit.hash;
      li.innerHTML = `
        <div class="search-result-main">
          <span class="search-result-subject" title="${esc(m.commit.subject)}">${esc(m.commit.subject)}</span>
          <code class="search-result-hash">${m.commit.hash.slice(0, 8)}</code>
        </div>
        <div class="search-result-meta muted">
          <span class="search-result-author">${esc(m.commit.author)}</span>
          <span>${isoDate(m.commit.timestamp)}</span>
          <span class="search-result-refs" title="Matched: ${esc(m.fields.join(', '))}">${esc(m.fields.join(' · '))}</span>
        </div>`;
      li.addEventListener('click', () => focusMatch(m.commit.hash));
      return li;
    }),
  );
}

export function openSearch(): void {
  const panel = $('#search-panel');
  panel.hidden = false;
  $('#btn-search').setAttribute('aria-expanded', 'true');
  // Anchor under the search button, clamped to the viewport.
  const rect = $('#btn-search').getBoundingClientRect();
  const width = panel.getBoundingClientRect().width;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  panel.style.left = `${left}px`;
  panel.style.right = 'auto';
  const input = $<HTMLInputElement>('#search-input');
  input.focus();
  input.select();
}

export function closeSearch(): void {
  const panel = $('#search-panel');
  if (panel.hidden) return;
  panel.hidden = true;
  $('#btn-search').setAttribute('aria-expanded', 'false');
  store.searchQuery = '';
  store.searchCurrent = null;
  store.searchMatches = [];
  $<HTMLInputElement>('#search-input').value = '';
  window.clearTimeout(searchDebounce);
  renderCached();
}

// Search only filters the already-fetched log, so debounce the rebuild and
// never hit `/state` while the user is typing.
export let searchDebounce: number | undefined;

export function initSearch(): void {
  $('#btn-search').addEventListener('click', () => {
    if ($('#search-panel').hidden) openSearch();
    else closeSearch();
  });

  $('#search-close').addEventListener('click', () => closeSearch());
  $('#search-next').addEventListener('click', () => searchStep(1));
  $('#search-prev').addEventListener('click', () => searchStep(-1));

  $('#search-input').addEventListener('input', (ev) => {
    store.searchQuery = (ev.target as HTMLInputElement).value;
    store.searchCurrent = null;
    window.clearTimeout(searchDebounce);
    searchDebounce = window.setTimeout(renderCached, 150);
  });

  $('#search-input').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      searchStep(ev.shiftKey ? -1 : 1);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      closeSearch();
    }
  });

  document.addEventListener('pointerdown', (ev) => {
    const panel = $('#search-panel');
    const btn = $('#btn-search');
    if (!panel.hidden && !panel.contains(ev.target as Node) && !btn.contains(ev.target as Node)) {
      closeSearch();
    }
  });

  document.addEventListener('keydown', (ev) => {
    const isFind = (ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'f';
    if (ev.key !== '/' && !isFind) return;
    const input = $<HTMLInputElement>('#search-input');
    if (isFind && document.activeElement === input && !$('#search-panel').hidden) {
      ev.preventDefault();
      input.select();
      return;
    }
    if (isTypingTarget(ev.target)) return;
    if (document.querySelector('dialog[open]')) return;
    ev.preventDefault();
    openSearch();
  });
}
