// Shared, cross-feature view state for the UI. A single mutable object keeps the
// per-tab and per-view globals in one place without a state library; feature
// modules read and write `store.*` directly. Feature-local state lives with its
// feature instead.

import type {
  ConflictEntry,
  GitCommit,
  GraphLayout,
  MergeOperation,
  RemoteStatus,
  RepoActivity,
  RepoState,
  RepoStatus,
  ReviewChanges,
  ReviewComment,
  ReviewJob,
  ReviewRequest,
  ReviewSession,
  SubmoduleInfo,
  WorktreeInfo,
} from '../types';

export interface StateResponse {
  configured: boolean;
  repoPath?: string;
  state?: RepoState;
  commits?: GitCommit[];
  status?: RepoStatus;
  conflicts?: ConflictEntry[];
  operation?: MergeOperation;
  submodules?: SubmoduleInfo[];
  worktrees?: WorktreeInfo[];
}

/** A repository open in a tab. Holds per-tab view state so switching is instant. */
export interface RepoTab {
  id: string;
  path: string;
  name: string;
  selectedHash: string | null;
  lastResponse: StateResponse | null;
  remoteStatus: RemoteStatus | null;
  panX: number;
  panY: number;
  zoom: number;

  // Panels this repository owns. A review and any number of worktree terminals
  // live with their repo, so closing/activating a repo manages them directly.
  review: ReviewTabState | null;
  /** Embedded terminals keyed by the worktree path the shell runs in. */
  terminals: Map<string, TerminalState>;
}

/** One search hit: a commit plus human labels for what matched. */
export interface SearchMatch {
  commit: GitCommit;
  fields: string[];
}

/** Per-repository review state, so several review tabs can coexist. */
export interface ReviewTabState {
  repoId: string;
  repoPath: string;
  changes: ReviewChanges | null;
  job: ReviewJob | null;
  poll: number | undefined;
  saveTimer: number | undefined;
  /** Local edits/approval state that must survive a poll re-render, keyed by comment id. */
  edits: Map<string, { body: string; status: ReviewComment['status'] }>;
  mrs: ReviewRequest[];
  mrIid: number;
  sessions: ReviewSession[];
  showRejected: boolean;
  sending: Set<string>;
  /** Set when the request head is missing, so the AI review runs diff-only. */
  headWarning: string | null;
}

/** An open embedded terminal, keyed by the worktree path it runs in. */
export interface TerminalState {
  /** Absolute path the shell was started in (the worktree directory). */
  path: string;
  /** Display name (the worktree directory's basename). */
  name: string;
  /** Repository the worktree belongs to, used to authorize the PTY. */
  repoId: string;
  repoPath: string;
  /** Active PTY session id, or null while the session is opening. */
  id: string | null;
}

/**
 * Which panel occupies the main columns. A single discriminant replaces the
 * former `activeReviewId`/`activeTerminalPath` pair, so the graph, a review, and
 * a terminal are mutually exclusive by construction.
 */
export type ActivePanel =
  | { kind: 'graph' }
  | { kind: 'review'; repoId: string }
  | { kind: 'terminal'; repoId: string; path: string };

interface ViewStore {
  tabs: RepoTab[];
  activeId: string | null;

  // Which panel the columns show. Panels are owned by their repository tab.
  activePanel: ActivePanel;

  // Active-tab view state, mirrored into the tab record on switch.
  currentLayout: GraphLayout | null;
  selectedHash: string | null;
  repoName: string;
  lastResponse: StateResponse | null;
  remoteStatus: RemoteStatus | null;

  // Search state, shared across tabs; results are recomputed per repo on render.
  searchQuery: string;
  searchCurrent: string | null;
  searchMatches: SearchMatch[];

  // Graph viewport transform: pan offset (px) and zoom scale.
  panX: number;
  panY: number;
  zoom: number;

  // Git command status bar snapshot for the active tab.
  activity: RepoActivity | null;
}

export const store: ViewStore = {
  tabs: [],
  activeId: null,
  activePanel: { kind: 'graph' },
  currentLayout: null,
  selectedHash: null,
  repoName: '',
  lastResponse: null,
  remoteStatus: null,
  searchQuery: '',
  searchCurrent: null,
  searchMatches: [],
  panX: 0,
  panY: 0,
  zoom: 1,
  activity: null,
};

export function activeTab(): RepoTab | undefined {
  return store.tabs.find((t) => t.id === store.activeId);
}

/** The terminal with this worktree path, wherever its owning repo tab is. */
export function terminalForPath(path: string): TerminalState | undefined {
  for (const tab of store.tabs) {
    const term = tab.terminals.get(path);
    if (term) return term;
  }
  return undefined;
}

/** True while `state`'s review is the visible panel. */
export function isReviewShown(state: ReviewTabState): boolean {
  const panel = store.activePanel;
  return panel.kind === 'review' && panel.repoId === state.repoId;
}

/** The review state currently shown, if any. */
export function activeReviewState(): ReviewTabState | null {
  const panel = store.activePanel;
  if (panel.kind !== 'review') return null;
  return store.tabs.find((t) => t.id === panel.repoId)?.review ?? null;
}

/** Copy the live active-tab globals back into the tab record. */
export function saveActive(): void {
  const t = activeTab();
  if (!t) return;
  t.selectedHash = store.selectedHash;
  t.lastResponse = store.lastResponse;
  t.remoteStatus = store.remoteStatus;
  t.panX = store.panX;
  t.panY = store.panY;
  t.zoom = store.zoom;
}
