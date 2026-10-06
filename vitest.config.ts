import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Resolve workspace packages to their TypeScript sources (see "source" export condition).
    conditions: ['source'],
  },
  // Tests run in Vite's SSR environment, which ignores the top-level `resolve.conditions`.
  // Without this, cross-package imports (server → core) would hit stale or missing `dist/`.
  ssr: {
    resolve: {
      conditions: ['source', 'module', 'node', 'development|production'],
      externalConditions: ['source'],
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'packages/ui/**'],
    environment: 'node',
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**'],
    },
  },
});
