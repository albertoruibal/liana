// Code-review backend: OpenAI-compatible chat client plus the bounded read-only
// agent loop that turns a merge/pull request into proposed comments. The forge
// client (GitLab/GitHub) lives behind src/forge.ts / src/forges.ts. Node-only:
// imported exclusively by src/api/index.ts (never the browser).
//
// All HTTP runs with AbortController timeouts and surfaces the upstream error
// body unchanged. Secrets are read from src/settings.ts and never logged.
//
// This barrel preserves the surface the API router has always imported; the
// implementation is split by concern under src/review/.

export { testProvider, completeText } from './ai';
export { generateCommitMessage, type CommitMessageInput } from './commit-message';
export { parseComments, parsePartialComments } from './comments';
export {
  listMergeRequests,
  getMergeRequestChanges,
  ensureMergeRequestRefs,
  checkoutMergeRequestBranch,
  createDiscussion,
  approveMergeRequest,
  testGitLab,
  testForge,
} from './delegations';
export {
  listReviewSessions,
  loadReviewSession,
  reviewJobRepo,
  saveReviewSessionComments,
  deleteReviewSession,
  getReviewJob,
  cancelReviewJob,
  pauseReviewJob,
  resumeReview,
  startReview,
  type StartReviewOptions,
} from './jobs';
