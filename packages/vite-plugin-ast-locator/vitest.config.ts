import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The API tests start Vite servers on temp copies of the playground.
    testTimeout: 30_000,
  },
})
