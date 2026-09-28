// Shared types for the git graph model and rendering.
// These mirror the JSON shapes returned by the local server (dev.ts / git.ts).

/** What a ref points at, so the UI can label local vs remote vs tag. */
export type RefKind = 'head' | 'local' | 'remote' | 'tag';

export interface GitRef {
  /** Display name: "main", "origin/main", "v1.0", "HEAD" */
  name: string;
  kind: RefKind;
}

export interface GitCommit {
  /** Full 40-char SHA */
  hash: string;
  /** Parent SHAs, first entry is the primary parent; empty for root commits */
  parents: string[];
  author: string;
  /** Author date, unix seconds */
  timestamp: number;
  subject: string;
  /** Refs pointing here, kind distinguishes local branch / remote branch / tag / HEAD */
  refs: GitRef[];
}

/** A commit placed in the graph grid */
export interface GraphNode {
  commit: GitCommit;
  /** Row index, 0 = top (newest) */
  row: number;
  /** Lane/column index, 0 = leftmost */
  column: number;
}

/** Directed edge child -> parent, in row/column coordinates */
export interface GraphEdge {
  fromRow: number;
  fromColumn: number;
  toRow: number;
  toColumn: number;
  /** True for non-first-parent edges, drawn with a stronger curve */
  merge: boolean;
}

export interface GraphLayout {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Number of lanes used (>= 1) */
  columns: number;
}

export interface BranchInfo {
  name: string;
  hash: string;
  isHead: boolean;
  isRemote: boolean;
}

export interface RepoState {
  name: string;
  headBranch: string | null;
  detachedHead: boolean;
  branches: BranchInfo[];
}

export interface StatusEntry {
  /** Index (X) status char: 'M', 'A', 'D', 'R', '?', or ' ' when unchanged in the index */
  stagedX: string;
  /** Worktree (Y) status char: 'M', 'D', '?', or ' ' when unchanged in the worktree */
  unstagedY: string;
  path: string;
}

export interface RepoStatus {
  entries: StatusEntry[];
}

/** Per-commit action in an interactive-rebase todo list. */
export type RebaseAction = 'pick' | 'drop' | 'reword' | 'squash';

export interface RebaseTodoItem {
  hash: string;
  subject: string;
  author: string;
  timestamp: number;
  action: RebaseAction;
  /** Replacement message; required for reword/squash, ignored otherwise. */
  message?: string;
}