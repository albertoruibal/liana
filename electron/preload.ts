// Preload: the only bridge between the sandboxed renderer and the main process.
// Exposes a minimal, explicit surface — no Node, no ipcRenderer passthrough.

import { contextBridge, ipcRenderer } from 'electron';

// The main process appends `?lianaToken=<random>` when loading the packaged UI.
// Under `vite dev` there is no token and no header is sent.
const token = new URLSearchParams(location.search).get('lianaToken') ?? undefined;

type PtyDataListener = (key: string, id: string, data: string) => void;
type PtyExitListener = (key: string, id: string, exitCode: number, signal?: number) => void;

// The preload is loaded once per window; keep a single pair of IPC subscriptions
// and fan out to the callbacks the UI registers.
const dataListeners = new Set<PtyDataListener>();
const exitListeners = new Set<PtyExitListener>();
let wired = false;

function wirePty(): void {
  if (wired) return;
  wired = true;
  ipcRenderer.on('liana:pty-data', (_ev, payload: { id: string; key: string; data: string }) => {
    for (const listener of dataListeners) listener(payload.key, payload.id, payload.data);
  });
  ipcRenderer.on(
    'liana:pty-exit',
    (_ev, payload: { id: string; key: string; exitCode: number; signal?: number }) => {
      for (const listener of exitListeners) {
        listener(payload.key, payload.id, payload.exitCode, payload.signal);
      }
    },
  );
}

contextBridge.exposeInMainWorld('liana', {
  token,
  /** True in the packaged/dev Electron app, where a PTY is available. */
  canRunTerminal: true,
  /** Native folder picker; resolves to an absolute path or null when cancelled. */
  openRepoDialog: (): Promise<string | null> => ipcRenderer.invoke('liana:open-repo'),
  pty: {
    /** Open a shell in `cwd` (must belong to `repoPath`); resolves to an id or null. */
    open: (opts: {
      repoPath: string;
      cwd: string;
      cols: number;
      rows: number;
      key: string;
    }): Promise<string | null> => ipcRenderer.invoke('liana:pty-open', opts),
    input: (id: string, data: string): void => ipcRenderer.send('liana:pty-input', { id, data }),
    resize: (id: string, cols: number, rows: number): void =>
      ipcRenderer.send('liana:pty-resize', { id, cols, rows }),
    close: (id: string): void => ipcRenderer.send('liana:pty-close', { id }),
    closeAll: (): void => ipcRenderer.send('liana:pty-close-all'),
    onData: (cb: PtyDataListener): void => {
      wirePty();
      dataListeners.add(cb);
    },
    onExit: (cb: PtyExitListener): void => {
      wirePty();
      exitListeners.add(cb);
    },
  },
});
