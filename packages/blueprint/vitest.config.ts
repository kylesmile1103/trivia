import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Tests sit beside the code they cover (specs/001-blueprint-schema/plan.md); test/ holds
    // the package-level ones.
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
})
