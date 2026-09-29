// Electron main process.
//
// Dev (`!app.isPackaged`): load the Vite dev server; its plugin serves /api.
// Packaged: start a 127.0.0.1 loopback server (electron/server.ts) that serves
// the built UI and the shared git API, then load it with a per-launch token.
//
// A GUI launch does not inherit a login shell's PATH, so git is resolved through
// an augmented PATH and a clear error is shown when it cannot be found.

import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from 'electron';
import path from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { startServer, type RunningServer } from './server';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_URL = process.env.LIANA_DEV_URL ?? 'http://localhost:5173';

/** App/window icon, shipped in the asar root (build/icon.png). */
const ICON_PATH = path.join(app.getAppPath(), 'build', 'icon.png');

// The installers embed the full-resolution 1024px PNG, but Electron only
// advertises _NET_WM_ICON to the window manager when the icon is smaller
// (~<256px); at 1024px it silently drops the hint and the WM falls back to a
// generic icon. Resize here, and keep the large original for the installers.
const WINDOW_ICON_SIZE = 192;

// Wayland resolves the dock/taskbar icon by matching the window's app_id to an
// installed .desktop file. Must be called before the `ready` event.
if (process.platform === 'linux') app.setDesktopName('dev.liana.app');

/**
 * Running a bare AppImage installs nothing, so on Wayland (which has no
 * per-window icon protocol) GNOME cannot match the window's app_id
 * (`dev.liana.app`) to a .desktop entry and draws a generic icon. Register a
 * per-user entry + themed icon on first run, pointing at the AppImage path.
 * No-op unless launched as an AppImage; failures never block startup.
 */
function integrateAppImage(): void {
  if (process.platform !== 'linux') return;
  const appImage = process.env.APPIMAGE;
  const appDir = process.env.APPDIR;
  if (!appImage || !appDir) return; // not an AppImage launch

  try {
    const dataHome = process.env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share');
    const iconDir = path.join(dataHome, 'icons', 'hicolor', '512x512', 'apps');
    const appsDir = path.join(dataHome, 'applications');
    const iconSrc = path.join(appDir, 'usr', 'share', 'icons', 'hicolor', '512x512', 'apps', 'liana.png');
    if (!existsSync(iconSrc)) return;

    mkdirSync(iconDir, { recursive: true });
    mkdirSync(appsDir, { recursive: true });
    writeFileSync(path.join(iconDir, 'liana.png'), readFileSync(iconSrc));

    const desktop = [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Liana',
      'Comment=Minimal git graph GUI',
      `Exec="${appImage}" --no-sandbox %U`,
      'Icon=liana',
      'Terminal=false',
      'Categories=Development;',
      'StartupWMClass=dev.liana.app',
      '',
    ].join('\n');
    writeFileSync(path.join(appsDir, 'dev.liana.app.desktop'), desktop);

    // Refresh the icon cache so the new entry is picked up promptly.
    spawnSync('gtk-update-icon-cache', ['-f', '-t', path.join(dataHome, 'icons', 'hicolor')], {
      stdio: 'ignore',
    });
  } catch {
    // best-effort: a missing dock icon must never block the app
  }
}

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

/**
 * Load the window icon at a size Electron will actually hand to the window
 * manager, falling back to the path if decoding fails. macOS ignores
 * BrowserWindow.icon entirely; this only matters for X11.
 */
function windowIcon(): Electron.NativeImage | string {
  const image = nativeImage.createFromPath(ICON_PATH);
  if (image.isEmpty()) return ICON_PATH;
  return image.resize({ width: WINDOW_ICON_SIZE, height: WINDOW_ICON_SIZE, quality: 'best' });
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#1e1e1e',
    icon: windowIcon(),
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
  integrateAppImage();
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
