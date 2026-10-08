import { defineConfig, devices } from '@playwright/test'

// End-to-end tests drive the real stack: an example app (the user's Vite dev server with
// vite-plugin-ast-locator) and the designer proxying it. Two pairs run: the playground, for the
// editor itself, and refine-admin (Refine + shadcn + an OpenAPI mock), for the Refine work in
// docs/product.md. Ports are env-configurable so several worktrees can run suites side by side.
const appPort = Number(process.env.TRIVIA_APP_PORT ?? 5173)
const designerPort = Number(process.env.TRIVIA_PORT ?? 4400)
const refineAppPort = Number(process.env.TRIVIA_REFINE_APP_PORT ?? 5174)
const refineDesignerPort = Number(process.env.TRIVIA_REFINE_PORT ?? 4401)

const designer = (port: number, target: number, cache: string) => ({
  command: `pnpm --filter @trivia/designer exec vite`,
  url: `http://localhost:${port}/__trivia/`,
  env: { TRIVIA_TARGET: `http://localhost:${target}`, TRIVIA_PORT: String(port), TRIVIA_CACHE_DIR: cache },
  reuseExistingServer: false,
  timeout: 120_000,
})

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1, // tests edit the examples' files on disk
  timeout: 60_000,
  use: {
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  projects: [
    { name: 'playground', testIgnore: /refine\//, use: { baseURL: `http://localhost:${designerPort}` } },
    { name: 'refine', testMatch: /refine\/.*\.spec\.ts$/, use: { baseURL: `http://localhost:${refineDesignerPort}` } },
  ],
  webServer: [
    {
      command: `pnpm --filter playground exec vite --port ${appPort} --strictPort`,
      url: `http://localhost:${appPort}/`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    designer(designerPort, appPort, 'node_modules/.vite'),
    {
      command: `pnpm --filter refine-admin exec vite --port ${refineAppPort} --strictPort`,
      url: `http://localhost:${refineAppPort}/`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    designer(refineDesignerPort, refineAppPort, 'node_modules/.vite-refine'),
  ],
})
