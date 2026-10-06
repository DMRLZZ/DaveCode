import { defineConfig } from 'vitest/config';

// UI unit tests cover pure logic in src/lib (DAG layout, mock generators, formatting).
// The root Vitest config excludes packages/ui; run these with `pnpm --filter @davecode/ui test`.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
