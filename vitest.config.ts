import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    testTimeout: 60_000,
    // Server tests start worker threads in beforeAll; under a loaded full run that can pass 10 s.
    hookTimeout: 30_000,
  },
});
