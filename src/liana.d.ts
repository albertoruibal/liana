// Bridge exposed by electron/preload.ts. Absent in plain browser mode.

interface LianaPtyBridge {
  /** Open a shell in `cwd` (inside `repoPath`); resolves to a session id or null. */
  open(opts: {
    repoPath: string;
    cwd: string;
    cols: number;
    rows: number;
    /** Client key (the worktree path) echoed back on every frame. */
    key: string;
  }): Promise<string | null>;
  /** Send keystrokes/paste to a session. */
  input(id: string, data: string): void;
  /** Update a session's viewport size. */
  resize(id: string, cols: number, rows: number): void;
  /** Terminate a session. */
  close(id: string): void;
  /** Terminate every session owned by the renderer (used on reload/quit). */
  closeAll(): void;
  /** Subscribe to terminal output for a key; call once per session. */
  onData(cb: (key: string, id: string, data: string) => void): void;
  /** Subscribe to session exit for a key; call once per session. */
  onExit(cb: (key: string, id: string, exitCode: number, signal?: number) => void): void;
}

interface LianaBridge {
  /** Per-launch API token; undefined under `vite dev`. */
  token?: string;
  /** True when the embedded terminal can run (Electron main process present). */
  canRunTerminal?: boolean;
  /** Native folder picker; resolves to an absolute path or null when cancelled. */
  openRepoDialog(): Promise<string | null>;
  /** Embedded terminal (PTY) bridge; only present in Electron. */
  pty?: LianaPtyBridge;
}

interface Window {
  liana?: LianaBridge;
}
