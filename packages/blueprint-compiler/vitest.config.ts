import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // A file's first test that reads the kit's components (kitServiceContext) also loads the dev
    // service and the engine: 5.0 s on the uncached macOS nightly runner, past Vitest's 5 s default.
    testTimeout: 30_000,
  },
})
