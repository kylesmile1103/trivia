import { defineConfig, devices } from '@playwright/test'

// End-to-end tests drive the real stack: an example app (the user's Vite dev server with
// vite-plugin-ast-locator or Next App Router) and the designer proxying it. Ports are
// env-configurable so several worktrees can run suites side by side.
const appPort = Number(process.env.TRIVIA_APP_PORT ?? 5173)
const designerPort = Number(process.env.TRIVIA_PORT ?? 4400)
const refineAppPort = Number(process.env.TRIVIA_REFINE_APP_PORT ?? 5174)
const refineDesignerPort = Number(process.env.TRIVIA_REFINE_PORT ?? 4401)
const nextAppPort = Number(process.env.TRIVIA_NEXT_APP_PORT ?? 5175)
const nextDesignerPort = Number(process.env.TRIVIA_NEXT_PORT ?? 4402)
const nextApiPort = Number(process.env.TRIVIA_NEXT_API_PORT ?? 4403)
const kitAppPort = Number(process.env.TRIVIA_KIT_APP_PORT ?? 5176)
const kitDesignerPort = Number(process.env.TRIVIA_KIT_PORT ?? 4404)

const designer = (port: number, target: number, cache: string, apiPort?: number) => ({
  command: `pnpm --filter @trivia/designer exec vite`,
  url: `http://localhost:${port}/__trivia/`,
  env: {
    TRIVIA_TARGET: apiPort === undefined ? `http://localhost:${target}` : `http://127.0.0.1:${target}`,
    TRIVIA_API_TARGET: apiPort === undefined ? '' : `http://127.0.0.1:${apiPort}`,
    TRIVIA_PORT: String(port),
    TRIVIA_CACHE_DIR: cache,
  },
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
    { name: 'playground', testIgnore: /(?:refine|next)\/|blueprint(?:-kit)?\.spec\.ts$/, use: { baseURL: `http://localhost:${designerPort}` } },
    { name: 'refine', testMatch: /(?:refine\/.*|blueprint)\.spec\.ts$/, use: { baseURL: `http://localhost:${refineDesignerPort}` } },
    { name: 'blueprint-kit', testMatch: /blueprint-kit\.spec\.ts$/, use: { baseURL: `http://localhost:${kitDesignerPort}` } },
    { name: 'next', testMatch: /next\/.*\.spec\.ts$/, use: { baseURL: `http://localhost:${nextDesignerPort}` } },
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
    {
      command: `pnpm --filter next-admin dev --port ${nextAppPort} --service-port ${nextApiPort}`,
      url: `http://127.0.0.1:${nextAppPort}/`,
      reuseExistingServer: false,
      timeout: 120_000,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    },
    designer(nextDesignerPort, nextAppPort, 'node_modules/.vite-next', nextApiPort),
    {
      command: `pnpm --filter blueprint-kit exec vite --port ${kitAppPort} --strictPort`,
      url: `http://localhost:${kitAppPort}/`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    designer(kitDesignerPort, kitAppPort, 'node_modules/.vite-kit'),
  ],
})
