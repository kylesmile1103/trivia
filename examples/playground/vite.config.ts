import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import astLocator from '@trivia/vite-plugin-ast-locator'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

import { mockApi } from './mock-api.ts'

// https://vite.dev/config/
export default defineConfig({
  // astLocator first: it must see the JSX before React's transform compiles it away.
  // mockApi: the customers API the data examples use (openapi/customers.openapi.json).
  plugins: [astLocator(), react(), tailwindcss(), mockApi()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
})
