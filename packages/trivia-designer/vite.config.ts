import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * The designer lives under /__trivia/ and proxies every other path — HTTP and WebSocket —
 * to the user's Vite dev server. The canvas iframe loads "/" from this same origin, so the
 * designer can read `iframe.contentDocument` directly, and the user app's HMR socket and
 * the engine API (/@trivia/api, served by vite-plugin-ast-locator) pass through untouched.
 */
const target = process.env.TRIVIA_TARGET ?? 'http://localhost:5173'

export default defineConfig({
  base: '/__trivia/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    port: Number(process.env.TRIVIA_PORT ?? 4400),
    strictPort: true,
    proxy: {
      '^/(?!__trivia(?:[/?#]|$))': { target, changeOrigin: true, ws: true },
    },
  },
})
