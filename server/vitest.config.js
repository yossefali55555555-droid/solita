import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./tests/globalSetup.js'],
    setupFiles: ['./tests/setup.js'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // Each test file uses its own isolated database on the in-memory server.
    fileParallelism: true,
  },
});
