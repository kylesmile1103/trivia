import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

import { apiGuard, isApiUpgrade } from './api-guard.ts'

/**
 * The designer lives under /__trivia/ and proxies every other path — HTTP and WebSocket —
 * to the user's Vite dev server. The canvas iframe loads "/" from this same origin, so the
 * designer can read `iframe.contentDocument` directly, and the user app's HMR socket passes
 * through untouched. So does the engine API (/@trivia/api, served by vite-plugin-ast-locator),
 * but only for this machine: the proxy hides its client from the plugin, so `apiGuard` makes
 * the plugin's checks here (docs/api.md, Envelope).
 */
const target = process.env.TRIVIA_TARGET ?? 'http://localhost:5173'

export default defineConfig({
  base: '/__trivia/',
  plugins: [apiGuard(), react(), tailwindcss()],
  // The shell names the proxied dev server in its status chip and its "can't connect" screen.
  define: { __TRIVIA_TARGET__: JSON.stringify(target) },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    port: Number(process.env.TRIVIA_PORT ?? 4400),
    strictPort: true,
    proxy: {
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
