import { defineConfig } from 'tsup';

/**
 * One shebang-free ESM entry (`bin/davecode.js` imports it) plus lazily loaded chunks, one per
 * command, so `davecode --help` never loads SQLite, Fastify, React or Ink.
 * Dependencies (including the workspace packages `@davecode/core` and `@davecode/server`) stay
 * external and are resolved from node_modules at runtime; build them first (`pnpm build`).
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  splitting: true,
  sourcemap: true,
  clean: true,
  dts: false,
  esbuildOptions(options) {
    options.jsx = 'automatic';
  },
});
