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

/** A model-proposed resolution for one conflicted path, for the AI merge dialog. */
export interface AiConflictFix {
  path: string;
  /** `content` carries the merged file; `delete` resolves by removing the path. */
  kind: 'content' | 'delete';
  /** The full merged file (null when `kind` is `delete`). */
  content: string | null;
  /** A short natural-language explanation of the merge, shown above the result. */
  explanation: string;
  /** Model that produced the proposal, for display. */
  model: string;
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

/** A linked working tree of a repository (`git worktree list --porcelain`). */
export interface WorktreeInfo {
  /** Absolute path of the working tree. */
  path: string;
  /** HEAD commit checked out in the worktree, or null for bare/prunable entries. */
  head: string | null;
  /** Short branch name, or null when detached or bare. */
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  /** Reason recorded with the lock, or null when unlocked/unspecified. */
  lockReason: string | null;
  /** True when git considers the worktree prunable (its directory is gone). */
  prunable: boolean;
  prunableReason: string | null;
  /** True for the main working tree (the first entry of `git worktree list`). */
  isMain: boolean;
  /** True when this is the repository the request was scoped to. */
  isCurrent: boolean;
}

// --- Code review, AI providers & GitLab ---

/**
/** Severity attached to a proposed review comment. */
export type ReviewSeverity = 'info' | 'warning' | 'error';

/**
 * A configured OpenAI-compatible endpoint. The renderer never receives the
 * stored key — only whether one exists (`hasKey`).
 */
export interface AiProviderConfig {
  id: string;
  name: string;
  /** Base URL up to and including the API version, e.g. `http://localhost:11434/v1`. */
  baseUrl: string;
  model: string;
  hasKey: boolean;
  /** Model context window in tokens (used for the chars/4 budget). */
  contextWindow: number;
  maxTokens: number;
  temperature: number;
  /** Output bytes kept per tool result before pruning. */
  toolResultChars: number;
  maxSteps: number;
}

/** A model discovered on an OpenAI-compatible endpoint by the settings "Retrieve" button. */
export interface AiModelInfo {
  id: string;
  /** Context window in tokens, when the endpoint reports it. */
  contextWindow?: number;
  /** Suggested max output tokens, when the endpoint reports it. */
  maxTokens?: number;
}

/** Reviewer instructions and policy ("revision rule") applied to every review. */
export interface ReviewRuleConfig {
  /** Natural-language reviewer guidance prepended to the system prompt. */
  instructions: string;
  /** Minimum severity to keep from the model's output. */
  severityThreshold: ReviewSeverity;
  /** Path globs to exclude from review and from the agent's file list. */
  ignoreGlobs: string[];
  /** Cap on proposed comments per review (0 = unlimited). */
  maxComments: number;
  /** Preferred language for comment bodies. */
  language: string;
  maxSteps: number;
  /** Review changed files in context-sized batches rather than one prompt. */
  batchByFile: boolean;
}

/** Configuration for AI commit-message generation, shared by UI and backend. */
export interface CommitMessageConfig {
  /** Natural-language guidance prepended to the generation prompt. */
  instructions: string;
  /** Preferred language for the generated message. */
  language: string;
  /** Include recent commit subjects so the model matches the repo's style. */
  includeHistory: boolean;
  /** Cap on combined diff characters sent to the model. */
  maxDiffChars: number;
}

/** Which forge a repository reviews against. */
export type ForgeKind = 'gitlab' | 'github';

/** GitLab connection settings. The token is never returned to the renderer. */
export interface GitLabConfig {
  baseUrl: string;
  hasToken: boolean;
  /** Explicit project id/path override; empty derives it from `origin`. */
  projectId: string;
}

/** GitHub / GitHub Enterprise Server connection settings (secrets masked). */
export interface GitHubConfig {
  /** API base URL: `https://api.github.com` or `https://<host>/api/v3` for GHES. */
  baseUrl: string;
  hasToken: boolean;
  /** Explicit `owner/name` override; empty derives it from `origin`. */
  repo: string;
}

/** Full settings as exposed to the renderer (all secrets masked). */
export interface AppSettings {
  ai: {
    providers: AiProviderConfig[];
    activeProviderId: string | null;
  };
  review: ReviewRuleConfig;
  commit: CommitMessageConfig;
  gitlab: GitLabConfig;
  github: GitHubConfig;
  /** Forge selection: `auto` detects from `origin`, otherwise force one. */
  forge: ForgeKind | 'auto';
}

/** An open merge/pull request, reduced to the fields the UI needs. */
export interface ReviewRequest {
  /** Merge request iid / pull request number. */
  iid: number;
  title: string;
  author: string;
  sourceBranch: string;
  targetBranch: string;
  state: string;
  webUrl: string;
  updatedAt: string;
  draft: boolean;
}

/** One changed file in a request, with its unified diff. */
export interface ReviewFile {
  oldPath: string;
  newPath: string;
  newFile: boolean;
  deletedFile: boolean;
  renamedFile: boolean;
  /** Unified diff text (may be empty for binary/too-large files). */
  diff: string;
}

/** Diff anchors required to position a line-level review comment. */
export interface DiffRefs {
  baseSha: string;
  headSha: string;
  startSha: string;
}

/** A request plus its changed files and diff refs. */
export interface ReviewChanges {
  /** Forge the request came from. */
  forge: ForgeKind;
  mr: ReviewRequest;
  files: ReviewFile[];
  diffRefs: DiffRefs;
}

// Back-compat aliases: the persisted session wire shape keeps the `mr`/`iid`
// names and GitLab-flavoured type names so existing sessions and imports keep
// compiling. The forge field distinguishes them at runtime.
export type GitLabMergeRequest = ReviewRequest;
export type GitLabMrFile = ReviewFile;
export type GitLabDiffRefs = DiffRefs;
export type GitLabMrChanges = ReviewChanges;

/** Lifecycle of a proposed comment through the approval queue. */
export type ReviewCommentStatus = 'pending' | 'approved' | 'rejected' | 'posted' | 'failed';

/**
 * How firm a proposed comment is: `pending` was scanned from the model's
 * streamed output and may still change; `parsed` is a validated final result.
 */
export type ReviewCommentStage = 'pending' | 'parsed';

/** One proposed review comment, anchored to a line when possible. */
export interface ReviewComment {
  id: string;
  filePath: string;
  /** Old-side line for deletion/context anchors; null when not set. */
  oldLine: number | null;
  /** New-side line for added/context anchors; null when not set. */
  newLine: number | null;
  severity: ReviewSeverity;
  body: string;
  status: ReviewCommentStatus;
  stage: ReviewCommentStage;
  discussionId: string | null;
  error: string | null;
}

/** One executed tool call in the agent trace, for UI transparency. */
export interface ReviewTraceStep {
  step: number;
  tool: string;
  args: Record<string, unknown>;
  resultSummary: string;
  durationMs: number;
}

/** One model request as actually sent, for UI transparency. */
export interface ReviewPromptStep {
  /** Agent-loop step this request belongs to. */
  step: number;
  /** Serialized wire messages, capped; see `truncated`/`chars`. */
  text: string;
  /** Full length of the prompt before truncation. */
  chars: number;
  truncated: boolean;
  /** Wall-clock time the model call took, in milliseconds. */
  durationMs: number;
  /** Prompt tokens reported by the endpoint, or estimated; null when unknown. */
  promptTokens: number | null;
  /** Completion tokens reported by the endpoint, or estimated; null when unknown. */
  completionTokens: number | null;
  /** True when the token counts are the chars/4 estimate rather than real usage. */
  usageEstimated: boolean;
}

/** Lifecycle of a review job; `paused` and `error` are resumable, `cancelled` is terminal. */
export type ReviewJobState = 'running' | 'paused' | 'done' | 'error' | 'cancelled';

/** State of an in-flight review job, polled by the UI for live progress. */
export interface ReviewJob {
  id: string;
  state: ReviewJobState;
  batchIndex: number;
  batchTotal: number;
  /** Latest streamed model output (may be partial). */
  output: string;
  trace: ReviewTraceStep[];
  /** The exact requests sent to the model, in order. */
  prompts: ReviewPromptStep[];
  /** Accumulated wall-clock time across every model call, in milliseconds. */
  llmDurationMs: number;
  comments: ReviewComment[];
  error: string | null;
}

/**
 * Listing shape for a persisted review session. Never carries the agent
 * conversation or diffs — only what the UI needs to label and reopen it.
 */
export interface ReviewSession {
  id: string;
  iid: number;
  title: string;
  state: ReviewJobState;
  updatedAt: number;
  providerId: string | null;
  commentCount: number;
  batchIndex: number;
  batchTotal: number;
  /** Accumulated wall-clock time across every model call, in milliseconds. */
  llmDurationMs: number;
  /** Forge the session was created against (defaults to gitlab for old files). */
  forge: ForgeKind;
}

/** A review session restored in full, ready to render in the review view. */
export interface ReviewSessionView {
  session: ReviewSession;
  changes: ReviewChanges;
  job: ReviewJob;
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