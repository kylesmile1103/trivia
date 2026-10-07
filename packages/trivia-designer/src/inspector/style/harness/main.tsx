// StylePanel dev harness: the panel against the real engine, without the inspector/canvas
// workstreams. Served by the designer's dev server (not part of the production build):
//
//   pnpm --filter @trivia/designer dev   # with the user app running (TRIVIA_TARGET)
//   open http://localhost:4400/__trivia/src/inspector/style/harness/index.html
//        ?locator=src/pages/Dashboard.tsx%23Dashboard%230.0.1.0   (optional; or click an element)
//        &theme=dark                                              (optional)
//
// The user's app renders in a same-origin iframe; clicking an element selects the nearest
// usage-site locator. The panel is wired exactly as an embedder would wire it: previews go to
// the canvas API (installed here by a minimal iframe implementation), commits go through the
// action bus as one `updateProp className` op. e2e/style.spec.ts drives this page.

import '@/index.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'

import { Harness } from './Harness'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TooltipProvider>
      <Harness />
      <Toaster />
    </TooltipProvider>
  </StrictMode>,
)
