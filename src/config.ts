// Feature flags shared by the browser UI and the dev-server backend.
// Interactive rebase is the riskiest operation in the app: it rewrites history
// via a generated todo list, so it stays behind this flag until E2E-proven.

export const INTERACTIVE_REBASE_ENABLED = true;
