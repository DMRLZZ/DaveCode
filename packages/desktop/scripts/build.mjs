import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = fileURLToPath(new URL('../dist', import.meta.url));
// Only remove this package's generated dist directory.
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
});
await build({
  absWorkingDir: root,
  entryPoints: ['src/preload.ts'],
  outfile: 'dist/preload.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
});
const workspace = {
  '@davecode/core': '../../core/src/index.ts',
  '@davecode/server': '../../server/src/index.ts',
  '@dmrlzz/davecode/runtime': '../../cli/src/runtime.ts',
};
await build({
  absWorkingDir: root,
  entryPoints: ['src/backend.ts'],
  outfile: 'dist/backend.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  plugins: [
    {
      name: 'workspace',
      setup(builder) {
        builder.onResolve({ filter: /^@(davecode|dmrlzz)\// }, (args) => {
          const source = workspace[args.path];
          if (!source) throw new Error(`Unknown workspace import: ${args.path}`);
          return { path: fileURLToPath(new URL(source, import.meta.url)) };
        });
      },
    },
  ],
  conditions: ['source'],
});
await cp(new URL('../assets/', import.meta.url), dist, { recursive: true });
await cp(
  new URL('../../../site/assets/mark.svg', import.meta.url),
  new URL('../dist/mark.svg', import.meta.url),
);
