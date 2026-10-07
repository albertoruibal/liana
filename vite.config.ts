// Vite config: dev-server git API plugin + browser build.
// Optional default repo for dev/E2E: LIANA_REPO=/path/to/repo npm run dev

import { defineConfig } from 'vite';
import { apiPlugin } from './dev';
import pkg from './package.json';

export default defineConfig({
  plugins: [apiPlugin(process.env.LIANA_REPO ?? null)],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  // Monaco ships ESM + its own workers; let Vite's `?worker` imports handle them
  // and keep it out of dep pre-bundling so the workers resolve to real modules.
  optimizeDeps: { exclude: ['monaco-editor'] },
  server: { host: true, port: 5173 },
  build: { target: 'es2022', sourcemap: true },
});