// Bridge exposed by electron/preload.ts. Absent in plain browser mode.

interface LianaBridge {
  /** Per-launch API token; undefined under `vite dev`. */
  token?: string;
  /** Native folder picker; resolves to an absolute path or null when cancelled. */
  openRepoDialog(): Promise<string | null>;
}

interface Window {
  liana?: LianaBridge;
}
