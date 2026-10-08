import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Canvas } from '@/canvas/Canvas'
import { Inspector } from '@/inspector/Inspector'
import { useSession } from '@/lib/session'
import { useEngineSync } from '@/lib/useEngineSync'
import { Palette } from '@/registry/Palette'
import { ConnectingScreen, UnreachableScreen } from '@/toolbar/ConnectScreen'
import { useGlobalShortcuts } from '@/toolbar/shortcuts'
import { Toolbar } from '@/toolbar/Toolbar'

// Shell: toolbar over palette | canvas | inspector, once the engine has answered its health
// check. Before that, a full-screen state says what is (or isn't) reachable.
export default function App() {
  useEngineSync()
  useGlobalShortcuts()
  const status = useSession((s) => s.status)

  return (
    <TooltipProvider delayDuration={300}>
      {status === 'connected' ? (
        <div className="flex h-svh flex-col bg-background text-foreground">
          <Toolbar />
          <div className="flex min-h-0 flex-1">
            <Palette />
            <Canvas />
            <Inspector />
          </div>
        </div>
      ) : status === 'connecting' ? (
        <ConnectingScreen />
      ) : (
        <UnreachableScreen />
      )}
      <Toaster position="bottom-center" closeButton visibleToasts={4} />
    </TooltipProvider>
  )
}
