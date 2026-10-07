import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import astLocator from '@trivia/vite-plugin-ast-locator'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  // astLocator first: it must see the JSX before React's transform compiles it away.
  plugins: [astLocator(), react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
})
