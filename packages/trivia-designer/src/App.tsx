import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Canvas } from '@/canvas/Canvas'
import { Inspector } from '@/inspector/Inspector'
import { Palette } from '@/registry/Palette'

// Shell: palette | canvas | inspector. The shell workstream adds the toolbar, data loading
// (health, components, history) and keyboard shortcuts.
export default function App() {
  return (
    <TooltipProvider>
      <div className="flex h-svh flex-col bg-background text-foreground">
        <div className="flex min-h-0 flex-1">
          <Palette />
          <Canvas />
          <Inspector />
        </div>
      </div>
      <Toaster />
    </TooltipProvider>
  )
}
