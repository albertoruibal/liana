// Dev launcher: start Vite (whose plugin serves /api), then run Electron against it.
// Vite is started in-process via its Node API; Electron is a child. On exit the
// whole group is torn down and the Vite server is closed, so no child keeps :5173.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const electronPath = require('electron');

const server = await createServer({ server: { host: true } });
await server.listen();
const address = server.httpServer?.address();
const port = typeof address === 'object' && address !== null ? address.port : 5173;
const devUrl = `http://localhost:${port}`;
server.printUrls();

const extraArgs = (process.env.LIANA_ELECTRON_ARGS ?? '').split(/\s+/).filter(Boolean);
const child = spawn(electronPath, ['.', ...extraArgs], {
  stdio: 'inherit',
  env: { ...process.env, LIANA_DEV_URL: devUrl },
});

let shuttingDown = false;
async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
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
