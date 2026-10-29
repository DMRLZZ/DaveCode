import { mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
// Only remove this package's generated dist directory.
await rm(new URL('../dist', import.meta.url), { recursive: true, force: true });
await mkdir(new URL('../dist', import.meta.url), { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ['src/index.ts'],
  outfile: 'dist/worker.js',
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  minify: false,
  legalComments: 'none',
});
