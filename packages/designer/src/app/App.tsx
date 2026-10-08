import { Canvas } from '@/features/canvas'
import { Inspector } from '@/features/inspector'
import { Palette } from '@/features/palette'
import { Toolbar } from '@/features/toolbar'
import { useGlobalShortcuts } from '@/shared/commands/shortcuts'
import { useSession } from '@/shared/engine/session'
import { useEngineSync } from '@/shared/engine/useEngineSync'
import { Toaster } from '@/shared/ui/sonner'
import { TooltipProvider } from '@/shared/ui/tooltip'

import { ConnectingScreen, UnreachableScreen } from './ConnectScreen'

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
