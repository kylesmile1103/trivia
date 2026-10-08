import { ThemeProvider } from 'next-themes'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@/shared/ui/theme.css'
import App from './App.tsx'

const root = document.getElementById('root')
if (root === null) throw new Error('index.html has no #root element')

createRoot(root).render(
  <StrictMode>
    {/* The designer is same-origin with the user's app (it proxies it), so its localStorage
        is shared with the app: use a key the app won't. The pre-paint theme script lives in
        index.html; next-themes' own <script> never runs in a client-rendered app, so it is
        marked as a data block (which also keeps React from warning about it). */}
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      storageKey="trivia-designer-theme"
      scriptProps={{ type: 'application/json' }}
    >
      <App />
    </ThemeProvider>
  </StrictMode>,
)
