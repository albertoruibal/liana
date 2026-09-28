// Shared types for the git graph model and rendering.
// These mirror the JSON shapes returned by the local server (dev.ts / git.ts).

/** What a ref points at, so the UI can label local vs remote vs tag vs stash. */
export type RefKind = 'head' | 'local' | 'remote' | 'tag' | 'stash';

export interface GitRef {
  /** Display name: "main", "origin/main", "v1.0", "HEAD", "stash@{0}" */
  name: string;
  kind: RefKind;
}

/** Stash-specific metadata, present only on synthetic stash nodes. */
export interface StashInfo {
  /** Reflog selector, e.g. "stash@{0}" */
  selector: string;
  /** WIP commit hash (the `refs/stash` reflog entry) */
  hash: string;
  /** Message after "On <branch>: " */
  message: string;
  /** Branch the stash was created on, or null when unclear */
  branch: string | null;
  /** WIP commit parents: [base, index, (untracked)] */
  parents: string[];
  author: string;
  /** WIP commit timestamp, unix seconds */
  timestamp: number;
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
  /** Refs pointing here, kind distinguishes local branch / remote branch / tag / HEAD / stash */
  refs: GitRef[];
  /** True for synthetic stash nodes (the stash commit is not a normal history commit) */
  isStash?: boolean;
  /** Present on stash nodes in place of refs-based labeling */
  stash?: StashInfo;
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

/** One file changed by a commit, as reported by `git show --numstat/--name-status`. */
export interface CommitFile {
  /** Current path; rename/copy destination when applicable. */
  path: string;
  /** Source path for renames/copies, else null. */
  oldPath: string | null;
  /** Single-letter status: A, M, D, R, C, T, or '?' when unknown. */
  status: string;
  /** Added lines, or null for binary files. */
  additions: number | null;
  /** Deleted lines, or null for binary files. */
  deletions: number | null;
  /** True when git reports the change as binary (line counts are unavailable). */
  binary: boolean;
}

/** A configured remote with its fetch/push URL. */
export interface RemoteInfo {
  name: string;
  url: string;
}

/** Sync state of the checked-out branch against its upstream, plus configured remotes. */
export interface RemoteStatus {
  /** Checked-out branch, or null when detached. */
  currentBranch: string | null;
  remotes: RemoteInfo[];
  /** Upstream ref, e.g. "origin/main", or null when the branch has no upstream. */
  upstream: string | null;
  /** Commits on HEAD not on the upstream (0 when there is no upstream). */
  ahead: number;
  /** Commits on the upstream not on HEAD (0 when there is no upstream). */
  behind: number;
  /** Value of `credential.helper`, or null when unset. */
  credentialHelper: string | null;
}

/** Reset mode for `git reset --<mode>`, controlling index/worktree handling. */
export type ResetMode = 'soft' | 'mixed' | 'hard';

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