/// <reference types="vitest/config" />
import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

import { apiGuard, isApiUpgrade } from './server/api-guard.ts'

/**
 * The designer lives under /__trivia/ and proxies every other path — HTTP and WebSocket —
 * to the user's app server. The canvas iframe loads "/" from this same origin, so the
 * designer can read `iframe.contentDocument` directly, and the user app's HMR socket passes
 * through untouched. The engine API and MCP can have their own upstream (for Next.js),
 * but only for this machine: the proxy hides its client from the plugin, so `apiGuard` makes
 * the plugin's checks here (docs/api.md, Envelope).
 */
const target = process.env.TRIVIA_TARGET ?? 'http://localhost:5173'
const apiTarget = process.env.TRIVIA_API_TARGET

export default defineConfig({
  base: '/__trivia/',
  // Two designers at once (e2e runs one per example app) must not share a dependency cache.
  ...(process.env.TRIVIA_CACHE_DIR ? { cacheDir: process.env.TRIVIA_CACHE_DIR } : {}),
  plugins: [apiGuard(), react(), tailwindcss()],
  // The shell names the proxied dev server in its status chip and its "can't connect" screen.
  define: { __TRIVIA_TARGET__: JSON.stringify(target) },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  // A jsdom render takes about 0.3 s here and several seconds on a CI runner compiling Rust
  // beside it. Past the 5 s default a test is failed but keeps running against the shared
  // stores, and breaks the tests after it, so the limit only guards against a hang.
  test: { testTimeout: 30_000 },
  server: {
    port: Number(process.env.TRIVIA_PORT ?? 4400),
    strictPort: true,
    proxy: {
      ...(apiTarget ? {
        '^/@trivia/(?:api(?:[/?#]|$)|mcp(?:[?#]|$))': { target: apiTarget, changeOrigin: true },
      } : {}),
      '^/(?!__trivia(?:[/?#]|$))': {
        target,
        changeOrigin: true,
        ws: true,
        // false answers 404: the API has no WebSocket, and an upgrade never meets apiGuard.
        bypass: (req, res) => (isApiUpgrade(req, res) ? false : undefined),
      },
    },
  },
})
