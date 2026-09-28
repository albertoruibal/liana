// Vite config: dev-server git API plugin + browser build.
// Optional default repo for dev/E2E: LIANA_REPO=/path/to/repo npm run dev

import { defineConfig } from 'vite';
import { apiPlugin } from './dev';

export default defineConfig({
  plugins: [apiPlugin(process.env.LIANA_REPO ?? null)],
  server: { host: true, port: 5173 },
  build: { target: 'es2022', sourcemap: true },
});