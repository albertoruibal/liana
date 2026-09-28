// Bundle the Electron main + preload processes with esbuild.
// Output:
//   dist-electron/main.mjs   — ESM main process (bundles electron/server.ts + src/api.ts)
//   dist-electron/preload.cjs — CommonJS preload (sandboxed preloads cannot be ESM)
//
// `electron` and node builtins stay external; everything else is inlined so the
// packaged app needs no node_modules.

import { build } from 'esbuild';

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  external: ['electron'],
  sourcemap: true,
  logLevel: 'info',
};

await build({
  ...shared,
  format: 'esm',
  entryPoints: ['electron/main.ts'],
  outfile: 'dist-electron/main.mjs',
  // esbuild rewrites import.meta.url correctly in ESM output.
});

await build({
  ...shared,
  format: 'cjs',
  entryPoints: ['electron/preload.ts'],
  outfile: 'dist-electron/preload.cjs',
});
