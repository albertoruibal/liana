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
  /** Source path for a rename/copy (R/C), else null. */
  oldPath: string | null;
}

export interface RepoStatus {
  entries: StatusEntry[];
}

/** How the two sides of an unmerged path differ, derived from the index stages. */
export type ConflictType =
  | 'both-modified'
  | 'both-added'
  | 'added-by-us'
  | 'added-by-them'
  | 'deleted-by-us'
  | 'deleted-by-them';

/** One unmerged index path (a conflict), from `git ls-files -u`. */
export interface ConflictEntry {
  path: string;
  type: ConflictType;
  /** Stage-1 (base) object id, or null when there is no common ancestor (add/add). */
  baseHash: string | null;
  /** Stage-2 (ours) object id, or null when that side deleted/never added the path. */
  oursHash: string | null;
  /** Stage-3 (theirs) object id, or null when that side deleted/never added the path. */
  theirsHash: string | null;
  /** True when the conflicted path is a gitlink (submodule). */
  isSubmodule: boolean;
}

/** A merge / rebase / cherry-pick / revert left in progress by a conflict. */
export interface MergeOperation {
  kind: 'rebase' | 'merge' | 'cherry-pick' | 'revert' | 'none';
  inProgress: boolean;
  /** Commit the operation is applying onto (rebase base or merged/cherry-picked head). */
  onto: string | null;
  /** Number of unmerged paths. */
  conflictCount: number;
  /** Branch name for the ours side (checked-out / rebased branch), or null when unknown. */
  oursLabel: string | null;
  /** Branch name for the theirs side (merge target), or null when unknown. */
  theirsLabel: string | null;
}

/** The three stage contents for one conflicted path, for the resolve dialog. */
export interface ConflictFile {
  path: string;
  type: ConflictType;
  hasBase: boolean;
  hasOurs: boolean;
  hasTheirs: boolean;
  /** True when any present version is binary (contents omitted). */
  isBinary: boolean;
  /** True when the path is a gitlink (submodule); contents are the commit ids. */
  isSubmodule: boolean;
  base: string | null;
  ours: string | null;
  theirs: string | null;
  /** Current working-tree contents (conflict markers included), or null when absent. */
  worktree: string | null;
  /** True when a working-tree file exists and can be edited and staged. */
  worktreeAvailable: boolean;
  /** Branch name for the ours side, shown in the dialog in place of "Ours"; null when unknown. */
  oursLabel: string | null;
  /** Branch name for the theirs side, shown in the dialog in place of "Theirs"; null when unknown. */
  theirsLabel: string | null;
}

/** Original and modified text of one file, for the read-only Monaco viewer / diff. */
export interface FileContents {
  path: string;
  /** Old-side text (commit parent or HEAD), or null when the file did not exist. */
  original: string | null;
  /** New-side text (the commit tree or the working tree), or null when deleted. */
  modified: string | null;
  /** True when either side is binary (contents omitted). */
  binary: boolean;
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
  /** True when the path is a gitlink (mode 160000, a submodule) in the new tree. */
  isSubmodule: boolean;
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

/** A single `git` invocation observed by the backend, surfaced in the UI status bar. */
export interface GitCommandRecord {
  /** Full argument vector, without the leading `git`. */
  argv: string[];
  /** Human-readable command line, e.g. `git log --all --date-order`. */
  display: string;
  /** True while the process is still running. */
  running: boolean;
  /** Process exit code, or null while running (or when killed by a signal). */
  exitCode: number | null;
  /** Wall-clock duration in milliseconds, or null while running. */
  durationMs: number | null;
  /** Epoch milliseconds when the process started. */
  startedAt: number;
  /** Epoch milliseconds when the process finished, or null while running. */
  finishedAt: number | null;
  /** True when the command failed (nonzero exit or failed to spawn). */
  failed: boolean;
  /** True for user-driven commands (push, commit, …) vs background reads (log, show, …). */
  userInitiated: boolean;
}

/** A configured submodule and its checked-out state. */
export interface SubmoduleInfo {
  /** Submodule name from `.gitmodules` (usually its path). */
  name: string;
  path: string;
  url: string;
  /** Configured tracking branch, or null when unset. */
  branch: string | null;
  /** Commit id recorded in the superproject's index/HEAD, or null when untracked. */
  recordedHash: string | null;
  /** Commit currently checked out in the submodule, or null when uninitialized. */
  worktreeHash: string | null;
  /** `current` (clean), `modified` (different commit), `uninitialized`, `conflicted`, or `untracked`. */
  status: 'current' | 'modified' | 'uninitialized' | 'conflicted' | 'untracked';
}

/** Current git activity for one repository, for the status bar. */
export interface RepoActivity {
  /** Most recently started command still running, or null when idle. */
  running: GitCommandRecord | null;
  /** Most recent user action, or the last finished command when none has run. */
  last: GitCommandRecord | null;
  /** Number of git processes currently running for this repository. */
  active: number;
  /** The last 10 user-initiated commands, most recent first. */
  history: GitCommandRecord[];
}