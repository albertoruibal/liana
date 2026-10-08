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

interface ViewStore {
  tabs: RepoTab[];
  activeId: string | null;

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

  // Review tabs keyed by the repository id they are bound to.
  reviewTabs: Map<string, ReviewTabState>;
  activeReviewId: string | null;

  // Embedded terminals keyed by the worktree path the shell runs in.
  terminals: Map<string, TerminalState>;
  /** Worktree path of the visible terminal, or null when none is shown. */
  activeTerminalPath: string | null;
}

export const store: ViewStore = {
  tabs: [],
  activeId: null,
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
  reviewTabs: new Map(),
  activeReviewId: null,
  terminals: new Map(),
  activeTerminalPath: null,
};

export function activeTab(): RepoTab | undefined {
  return store.tabs.find((t) => t.id === store.activeId);
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
