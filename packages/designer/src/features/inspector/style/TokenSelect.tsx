// A select of named theme tokens (radius, font size, weight). Picking commits immediately;
// "Not set" removes the utility.

import { cn } from 'cn'

import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/shared/ui/select'

// Radix Select reserves "" for "no value", so unsetting goes through a sentinel item.
const UNSET = '__unset'

export interface TokenOption {
  value: string
  label: string
  /** Muted detail after the label ("500"). */
  detail?: string
}

export interface TokenSelectProps {
  label: string
  /** Selected option value, or null when unset or not a named token. */
  value: string | null
  options: readonly TokenOption[]
  /** Trigger text when no option matches but something is set ("Custom"). */
  placeholder: string
  onPick(value: string): void
  onClear(): void
  className?: string
}

export function TokenSelect({ label, value, options, placeholder, onPick, onClear, className }: TokenSelectProps) {
  return (
    <Select
      value={value ?? ''}
      onValueChange={(v) => {
        if (v === UNSET) onClear()
        else onPick(v)
      }}
    >
      <SelectTrigger size="sm" aria-label={label} className={cn('h-7 min-w-0 gap-1 px-2 text-xs', className)}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className="max-h-72">
        <SelectItem value={UNSET} className="text-xs text-muted-foreground">
          Not set
        </SelectItem>
        <SelectSeparator />
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} className="text-xs">
            {o.label}
            {o.detail && <span className="ml-auto pl-3 text-muted-foreground tabular-nums">{o.detail}</span>}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
