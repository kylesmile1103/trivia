import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Only test/: generators/package/files/test holds a template, not a test of this package.
    include: ['test/**/*.test.ts'],
  },
})
