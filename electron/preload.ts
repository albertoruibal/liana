// Preload: the only bridge between the sandboxed renderer and the main process.
// Exposes a minimal, explicit surface — no Node, no ipcRenderer passthrough.

import { contextBridge, ipcRenderer } from 'electron';

// The main process appends `?lianaToken=<random>` when loading the packaged UI.
// Under `vite dev` there is no token and no header is sent.
const token = new URLSearchParams(location.search).get('lianaToken') ?? undefined;

contextBridge.exposeInMainWorld('liana', {
  token,
  /** Native folder picker; resolves to an absolute path or null when cancelled. */
  openRepoDialog: (): Promise<string | null> => ipcRenderer.invoke('liana:open-repo'),
});
