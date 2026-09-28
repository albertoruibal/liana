// Vite dev-server plugin: exposes the shared git API (src/api.ts) under /api/*.
// The browser UI never links native git bindings; it talks to this plugin.
// Runs only under `vite dev`; production builds are static — start `npm run dev`.

import type { Connect, Plugin, ViteDevServer } from 'vite';
import { createApi } from './src/api';

function sendJson(res: Connect.IncomingMessage, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

async function readBody(req: Connect.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export function apiPlugin(defaultRepo: string | null): Plugin {
  return {
    name: 'liana-api',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      const api = createApi(defaultRepo);

      server.middlewares.use('/api', (req, res) => {
        const route = (req.url ?? '').split('?')[0]!;
        const method = req.method ?? 'GET';
        void (async (): Promise<void> => {
          const rawBody = method === 'GET' ? '' : await readBody(req);
          const { status, body } = await api.handle(route, method, rawBody);
          sendJson(res, status, body);
        })();
      });
    },
  };
}
