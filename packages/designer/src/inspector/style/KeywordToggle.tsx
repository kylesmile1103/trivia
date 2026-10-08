// A single-choice toggle group for keyword properties (display, align-items, …). Picking an
// option commits immediately (no preview); clicking the active option again unsets it.

import { cn } from 'cn'
import type { ReactNode } from 'react'

import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cssToTailwind, type StyleProperty, type Utility } from '@/lib/tailwind'

import { PANEL_THEME, useEditor } from './editor'
import { SEGMENT_ITEM } from './fields'

export interface KeywordOption {
  /** CSS value (`flex-start`, `none`). */
  value: string
  /** Visible content; defaults to the class (`items-start`, `hidden`). */
  content?: ReactNode
  /** Tooltip/accessible name prefix ("Start"). */
  title: string
}

export interface KeywordToggleProps {
  property: StyleProperty
  utility: Utility
  /** History label and group name ("Display"). */
  label: string
  options: readonly KeywordOption[]
  /** Current CSS value from the className, or null. */
  value: string | null
  className?: string
  itemClassName?: string
}

export function KeywordToggle({ property, utility, label, options, value, className, itemClassName }: KeywordToggleProps) {
  const editor = useEditor()
  return (
    <ToggleGroup
      type="single"
      size="sm"
      variant="outline"
      spacing={0}
      aria-label={label}
      className={cn('min-w-0', className)}
      value={value ?? ''}
      onValueChange={(next) => {
        if (next === '') editor.clear([utility], label)
        else editor.commitStyle({ [property]: next }, label)
      }}
    >
      {options.map((option) => {
        const cls = cssToTailwind(property, option.value, PANEL_THEME)
        return (
          <Tooltip key={option.value}>
            <TooltipTrigger asChild>
              <ToggleGroupItem value={option.value} aria-label={`${option.title} (${cls})`} className={cn('h-7 min-w-7 px-1.5', SEGMENT_ITEM, itemClassName)}>
                {option.content ?? cls}
              </ToggleGroupItem>
            </TooltipTrigger>
            <TooltipContent side="top">
              {option.title} <code className="font-mono opacity-70">{cls}</code>
            </TooltipContent>
          </Tooltip>
        )
      })}
    </ToggleGroup>
  )
}
