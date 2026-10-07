import { defineConfig, devices } from '@playwright/test'

// End-to-end tests drive the real stack: the playground app (user's Vite dev server with
// vite-plugin-ast-locator) and the designer proxying it. Ports are env-configurable so
// several worktrees can run suites side by side.
const appPort = Number(process.env.TRIVIA_APP_PORT ?? 5173)
const designerPort = Number(process.env.TRIVIA_PORT ?? 4400)

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1, // tests edit the playground's files on disk
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${designerPort}`,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: [
    {
      command: `pnpm --filter playground exec vite --port ${appPort} --strictPort`,
      url: `http://localhost:${appPort}/`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `pnpm --filter @trivia/designer exec vite`,
      url: `http://localhost:${designerPort}/__trivia/`,
      env: { TRIVIA_TARGET: `http://localhost:${appPort}`, TRIVIA_PORT: String(designerPort) },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
})
