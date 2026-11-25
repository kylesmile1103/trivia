import path from 'node:path'

import { defineConfig, devices } from '@playwright/test'

import { blueprintNextUnavailable } from './e2e/blueprint-next-prerequisites.mjs'
import { missingMvpPrerequisite } from './tools/blueprint/mvp-project.mjs'

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
const blueprintNextAppPort = Number(process.env.TRIVIA_BLUEPRINT_NEXT_APP_PORT ?? 5486)
const blueprintNextReason = blueprintNextUnavailable()
const mvpAppPort = Number(process.env.TRIVIA_MVP_APP_PORT ?? 5476)
const mvpDesignerPort = Number(process.env.TRIVIA_MVP_PORT ?? 4576)
const missingMvp = missingMvpPrerequisite()

// The dev service runs `trivia-dotnet` for the backend routes. The apps' servers find this
// checkout's build of it first: `e2e/bin` holds a shim for what `nx run dotnet:tool` publishes.
const appEnv = { PATH: [path.resolve('e2e/bin'), process.env.PATH ?? ''].join(path.delimiter) }

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
    { name: 'playground', testIgnore: /(?:refine|next)\/|blueprint(?:-kit|-mvp|-next)?\.spec\.ts$/, use: { baseURL: `http://localhost:${designerPort}` } },
    { name: 'refine', testMatch: /(?:refine\/.*|blueprint)\.spec\.ts$/, use: { baseURL: `http://localhost:${refineDesignerPort}` } },
    { name: 'blueprint-kit', testMatch: /blueprint-kit\.spec\.ts$/, use: { baseURL: `http://localhost:${kitDesignerPort}` } },
    { name: 'blueprint-next', testMatch: /blueprint-next\.spec\.ts$/, metadata: { blueprintNextUnavailable: blueprintNextReason },
      use: { baseURL: `http://127.0.0.1:${blueprintNextAppPort}` } },
    {
      name: 'blueprint-mvp',
      testMatch: /blueprint-mvp\.spec\.ts$/,
      metadata: { missingMvp },
      use: { baseURL: `http://localhost:${mvpDesignerPort}` },
    },
    { name: 'next', testMatch: /next\/.*\.spec\.ts$/, use: { baseURL: `http://localhost:${nextDesignerPort}` } },
  ],
  webServer: [
    {
      command: `pnpm --filter playground exec vite --port ${appPort} --strictPort`,
      url: `http://localhost:${appPort}/`,
      env: appEnv,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    designer(designerPort, appPort, 'node_modules/.vite'),
    {
      command: `pnpm --filter refine-admin exec vite --port ${refineAppPort} --strictPort`,
      url: `http://localhost:${refineAppPort}/`,
      env: appEnv,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    designer(refineDesignerPort, refineAppPort, 'node_modules/.vite-refine'),
    {
      command: `pnpm --filter next-admin dev --port ${nextAppPort} --service-port ${nextApiPort}`,
      url: `http://127.0.0.1:${nextAppPort}/`,
      env: appEnv,
      reuseExistingServer: false,
      timeout: 120_000,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    },
    designer(nextDesignerPort, nextAppPort, 'node_modules/.vite-next', nextApiPort),
    {
      command: `pnpm --filter blueprint-kit exec vite --port ${kitAppPort} --strictPort`,
      url: `http://localhost:${kitAppPort}/`,
      env: appEnv,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    designer(kitDesignerPort, kitAppPort, 'node_modules/.vite-kit'),
    ...(blueprintNextReason ? [] : [{
      command: 'node --experimental-strip-types e2e/blueprint-next-app.mjs',
      stdout: 'pipe' as const,
      url: `http://127.0.0.1:${blueprintNextAppPort}/customers`,
      env: appEnv,
      reuseExistingServer: false,
      timeout: 300_000,
      gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 20_000 },
    }]),
    ...(missingMvp ? [] : [
      {
        command: `node tools/blueprint/mvp-serve.mjs ${mvpAppPort}`,
        url: `http://localhost:${mvpAppPort}/api/v1/customers`,
        env: appEnv,
        reuseExistingServer: false,
        timeout: 480_000,
        gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 30_000 },
      },
      designer(mvpDesignerPort, mvpAppPort, 'node_modules/.vite-mvp'),
    ]),
  ],
})
