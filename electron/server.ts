// Packaged-mode backend: a loopback HTTP server that serves the built UI (`dist/`)
// and routes `/api/*` into the shared git API (`src/api.ts`).
// Bound to 127.0.0.1 on a fixed preferred port (ephemeral fallback); API calls
// require a per-launch token so other local processes cannot drive git through this server.

import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createApi } from '../src/api';

export interface ServerOptions {
  /** Repository to open at launch, or null to start unconfigured. */
  defaultRepo: string | null;
  /** Directory containing the built UI (index.html, assets/, …). */
  staticDir: string;
  /** Secret required in the `x-liana-token` header on /api requests. */
  token: string;
  /**
   * Preferred port. Binding it keeps the renderer's origin — and with it
   * localStorage (open tabs, theme, layout prefs) — stable across launches.
   */
  port?: number | null;
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function findFile(root: string, urlPath: string): string | null {
  // Resolve inside `root` only; reject traversal.
  const rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  try {
    return fs.statSync(abs).isFile() ? abs : null;
  } catch {
    return null;
  }
}

function serveStatic(res: ServerResponse, root: string, urlPath: string): void {
  const direct = findFile(root, urlPath);
  const target = direct ?? (path.extname(urlPath) ? null : path.join(root, 'index.html'));
  if (!target) {
    res.statusCode = 404;
    res.end('Not found');
    return;
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream');
  fs.createReadStream(target).pipe(res);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Bind `127.0.0.1` on the preferred port, falling back to nearby ports and
 * finally an ephemeral one when the preferred port is occupied (origin changes,
 * so persisted UI state is lost for that session — but the app still works).
 */
async function listenOn(server: http.Server, preferred: number | null): Promise<number> {
  const candidates =
    preferred !== null ? [preferred, preferred + 1, preferred + 2, preferred + 3, 0] : [0];
  for (const port of candidates) {
    try {
      return await new Promise<number>((resolve, reject) => {
        server.listen(port, '127.0.0.1', () => {
          const addr = server.address();
          resolve(typeof addr === 'object' && addr !== null ? addr.port : port);
        });
        server.once('error', reject);
      });
    } catch {
      // port taken — try the next candidate
    }
  }
  throw new Error('could not bind loopback server');
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const api = createApi(opts.defaultRepo);
  const root = path.resolve(opts.staticDir);

  const server = http.createServer((req, res) => {
    const urlPath = (req.url ?? '/').split('?')[0] ?? '/';

    if (urlPath === '/api' || urlPath.startsWith('/api/')) {
      if (req.headers['x-liana-token'] !== opts.token) {
        return sendJson(res, 403, { error: 'Forbidden' });
      }
      const route = urlPath.slice('/api'.length) || '/';
      const method = req.method ?? 'GET';
      const repoId = req.headers['x-liana-repo'];
      void (async (): Promise<void> => {
        const rawBody = method === 'GET' || method === 'HEAD' ? '' : await readBody(req);
        const { status, body } = await api.handle(
          route,
          method,
          rawBody,
          typeof repoId === 'string' ? repoId : undefined,
        );
        sendJson(res, status, body);
      })();
      return;
    }

    serveStatic(res, root, urlPath);
  });

  const port = await listenOn(server, opts.port ?? null);
  return {
    port,
    close: () =>
      new Promise<void>((done) => {
        server.close(() => done());
      }),
  };
}
