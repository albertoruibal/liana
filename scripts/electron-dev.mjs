// Dev launcher: start Vite (whose plugin serves /api), then run Electron against it.
// Vite is started in-process via its Node API; Electron is a child. On exit the
// whole group is torn down and the Vite server is closed, so no child keeps :5173.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const electronPath = require('electron');

// Wayland has no client-side window-icon protocol: the compositor looks up the
// icon by matching the window's app_id to an installed .desktop file. Dev runs
// from the repo (no installer), so register a throwaway entry while running.
// This no-ops on X11/macOS/Windows, where BrowserWindow.icon already works.
const APP_ID = 'dev.liana.app';

function registerDevDesktop() {
  if (process.platform !== 'linux') return null;
  if (process.env.XDG_SESSION_TYPE !== 'wayland' && !process.env.WAYLAND_DISPLAY) return null;

  const root = path.resolve(fileURLToPath(import.meta.url), '..', '..');
  const icon = path.join(root, 'build', 'icon.png');
  const dir = path.join(os.homedir(), '.local', 'share', 'applications');
  const file = path.join(dir, `${APP_ID}.desktop`);
  const contents = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Liana (dev)',
    `Icon=${icon}`,
    'Exec=liana-dev %U',
    `StartupWMClass=${APP_ID}`,
    'NoDisplay=true',
    'Categories=Development;',
    '',
  ].join('\n');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, contents);
    return file;
  } catch {
    return null; // best-effort: a missing icon must not block the dev run
  }
}

function unregisterDevDesktop(file) {
  if (!file) return;
  try {
    fs.rmSync(file);
  } catch {
    // already gone
  }
}

const server = await createServer({ server: { host: true } });
await server.listen();
const address = server.httpServer?.address();
const port = typeof address === 'object' && address !== null ? address.port : 5173;
const devUrl = `http://localhost:${port}`;
server.printUrls();

const extraArgs = (process.env.LIANA_ELECTRON_ARGS ?? '').split(/\s+/).filter(Boolean);
const devDesktop = registerDevDesktop();
const child = spawn(electronPath, ['.', ...extraArgs], {
  stdio: 'inherit',
  env: { ...process.env, LIANA_DEV_URL: devUrl },
});

let shuttingDown = false;
async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  unregisterDevDesktop(devDesktop);
  try {
    await server.close();
  } catch {
    // already closed
  }
  process.exit(code ?? 0);
}

child.on('close', (code) => void shutdown(code ?? 0));
process.on('SIGINT', () => {
  child.kill('SIGTERM');
  void shutdown(0);
});
process.on('SIGTERM', () => {
  child.kill('SIGTERM');
  void shutdown(0);
});
