// Electron main process.
//
// Dev (`!app.isPackaged`): load the Vite dev server; its plugin serves /api.
// Packaged: start a 127.0.0.1 loopback server (electron/server.ts) that serves
// the built UI and the shared git API, then load it with a per-launch token.
//
// A GUI launch does not inherit a login shell's PATH, so git is resolved through
// an augmented PATH and a clear error is shown when it cannot be found.

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { startServer, type RunningServer } from './server';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_URL = process.env.LIANA_DEV_URL ?? 'http://localhost:5173';

/** App/window icon, shipped in the asar root (build/icon.png). */
const ICON_PATH = path.join(app.getAppPath(), 'build', 'icon.png');

let server: RunningServer | null = null;
let token = '';
let gitAvailable = true;

/** Prepend common install locations so a GUI launch can find `git`. */
function ensureGitOnPath(): void {
  const extra = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/snap/bin'];
  const current = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const merged = [...extra.filter((p) => !current.includes(p)), ...current];
  process.env.PATH = merged.join(path.delimiter);
  if (process.platform === 'win32') return;
  gitAvailable = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#1e1e1e',
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Open external links in the system browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  return win;
}

async function bootstrap(): Promise<void> {
  ensureGitOnPath();
  const win = createWindow();

  if (app.isPackaged) {
    const defaultRepo = process.env.LIANA_REPO ?? null;
    token = randomBytes(24).toString('hex');
    server = await startServer({
      defaultRepo,
      staticDir: path.join(app.getAppPath(), 'dist'),
      token,
    });
    await win.loadURL(`http://127.0.0.1:${server.port}/?lianaToken=${token}`);
  } else {
    await win.loadURL(DEV_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  }

  if (!gitAvailable) {
    await dialog.showMessageBox(win, {
      type: 'error',
      title: 'git not found',
      message: 'Liana could not find the `git` executable on your PATH.',
      detail: 'Install git and relaunch, or make sure it is available in /usr/local/bin or /usr/bin.',
    });
  }
}

// Native folder picker, called from the renderer's preload bridge.
ipcMain.handle('liana:open-repo', async (): Promise<string | null> => {
  const result = await dialog.showOpenDialog({
    title: 'Open git repository',
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0] ?? null;
});

// Single instance: focus the existing window instead of opening a second one.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(bootstrap).catch((err: unknown) => {
    dialog.showErrorBox('Liana failed to start', String(err));
    app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void bootstrap();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('will-quit', () => {
    void server?.close();
  });
}
