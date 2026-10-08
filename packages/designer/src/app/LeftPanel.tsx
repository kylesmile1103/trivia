// The left column: the element tree (Layers), the component library (Components) and the
// project's API (Data), as tabs. The tab is in the store, so the `/` shortcut can bring the component search up.

import { DataPanel } from '@/features/data-explorer'
import { LayersPanel } from '@/features/layers'
import { Palette } from '@/features/palette'
import { designer, type LeftPanel as Tab, useDesigner } from '@/shared/state/store'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/ui/tabs'

export function LeftPanel() {
  const panel = useDesigner((s) => s.panel)
  return (
    <div className="flex w-60 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
      <Tabs value={panel} onValueChange={(tab) => designer.getState().setPanel(tab as Tab)} className="flex min-h-0 flex-1 flex-col gap-0">
        <TabsList variant="line" className="h-9 w-full shrink-0 justify-start border-b px-2">
          <TabsTrigger value="layers" className="flex-none px-2 text-xs">
            Layers
          </TabsTrigger>
          <TabsTrigger value="components" className="flex-none px-2 text-xs">
            Components
          </TabsTrigger>
          <TabsTrigger value="data" className="flex-none px-2 text-xs">
            Data
          </TabsTrigger>
        </TabsList>
        <TabsContent value="layers" className="flex min-h-0 flex-col">
          <LayersPanel />
        </TabsContent>
        <TabsContent value="components" className="flex min-h-0 flex-col">
          <Palette />
        </TabsContent>
        <TabsContent value="data" className="flex min-h-0 flex-col">
          <DataPanel />
        </TabsContent>
      </Tabs>
    </div>
  )
}
