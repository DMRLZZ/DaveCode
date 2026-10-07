import { cpSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsup';

const dashboardSrc = fileURLToPath(new URL('../ui/dist', import.meta.url));
const dashboardOut = fileURLToPath(new URL('./dist/dashboard', import.meta.url));

/**
 * One shebang-free ESM entry (`bin/davecode.js` imports it) plus lazily loaded chunks, one per
 * command, so `davecode --help` never loads SQLite, Fastify, React or Ink.
 *
 * The workspace packages `@davecode/core` and `@davecode/server` are bundled in, so the published
 * `davecode` package is standalone; their third-party dependencies are declared by this package
 * and stay external. The built dashboard (`packages/ui/dist`) is copied to `dist/dashboard`,
 * which `resolveDashboardDir()` checks first.
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
  noExternal: ['@davecode/core', '@davecode/server'],
  esbuildOptions(options) {
    options.jsx = 'automatic';
  },
  async onSuccess() {
    rmSync(dashboardOut, { recursive: true, force: true });
    if (existsSync(dashboardSrc)) {
      cpSync(dashboardSrc, dashboardOut, { recursive: true });
    } else {
      console.warn(
        '[davecode] packages/ui/dist not found: build @davecode/ui to bundle the dashboard',
      );
    }
  },
});
