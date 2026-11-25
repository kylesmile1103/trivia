// The left column's tab is in the shared store so the '/' shortcut can open component search.
import { Blocks, Database, DraftingCompass, Files, Layers } from 'lucide-react'

import { BlueprintTab } from '@/features/blueprint'
import { DataPanel } from '@/features/data-explorer'
import { LayersPanel } from '@/features/layers'
import { PagesPanel } from '@/features/pages'
import { Palette } from '@/features/palette'
import { designer, type LeftPanel as Tab, useDesigner } from '@/shared/state/store'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip'

const tabs = [
  { value: 'layers', label: 'Layers', Icon: Layers, Panel: LayersPanel },
  { value: 'pages', label: 'Pages', Icon: Files, Panel: PagesPanel },
  { value: 'components', label: 'Components', Icon: Blocks, Panel: Palette },
  { value: 'data', label: 'Data', Icon: Database, Panel: DataPanel },
  { value: 'blueprint', label: 'Blueprint', Icon: DraftingCompass, Panel: BlueprintTab },
] as const

export function LeftPanel() {
  const panel = useDesigner((s) => s.panel)
  return (
    <div className="flex w-68 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
      <Tabs value={panel} onValueChange={(tab) => designer.getState().setPanel(tab as Tab)} className="flex min-h-0 flex-1 flex-col gap-0">
        <TabsList variant="line" aria-label="Designer tools" className="h-9 w-full shrink-0 border-b px-2">
          {tabs.map(({ value, label, Icon }) => (
            <Tooltip key={value}>
              <TooltipTrigger asChild>
                <TabsTrigger value={value} aria-label={label}><Icon aria-hidden="true" /></TabsTrigger>
              </TooltipTrigger>
              <TooltipContent>{label}</TooltipContent>
            </Tooltip>
          ))}
        </TabsList>
        {tabs.map(({ value, Panel }) => (
          <TabsContent key={value} value={value} className="flex min-h-0 flex-col">
            <Panel />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  )
}
