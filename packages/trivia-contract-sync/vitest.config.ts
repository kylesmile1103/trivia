import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Child processes, not worker threads: the isolation tests call process.chdir(), which
    // worker threads don't support.
    pool: 'forks',
    // Codegen plus a real `tsc --noEmit` over the generated code takes a few seconds per fixture.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
