import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      reporter: ['text'],
    },
    // The suites share SQLite files and temp dirs, so run them one file at a time.
    fileParallelism: false,
  },
});
