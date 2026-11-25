import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

import { mockApi } from '../refine-admin/mock-api.ts'

export default defineConfig({
  plugins: [react(), tailwindcss(), mockApi()],
  resolve: { tsconfigPaths: true },
})
