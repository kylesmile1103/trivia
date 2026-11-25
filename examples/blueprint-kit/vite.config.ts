import { fileURLToPath } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import astLocator from '@trivia/vite-plugin-ast-locator'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

import { mockApi } from './mock-api.ts'

export default defineConfig({
  plugins: [astLocator(), react(), tailwindcss(), mockApi()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
})
