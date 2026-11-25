import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select'

interface EnumSetterProps {
  id: string
  pointer?: string
  options: string[]
  /** undefined while the attribute is absent: the placeholder shows the default. */
  value: string | undefined
  placeholder: string
  onCommit(value: string): void
}

export function EnumSetter({ id, pointer, options, value, placeholder, onCommit }: EnumSetterProps) {
  // A source value outside the schema's union still has to be visible as the current value.
  const items = value !== undefined && value !== '' && !options.includes(value) ? [...options, value] : options
  return (
    <Select value={value ?? ''} onValueChange={onCommit}>
      <SelectTrigger id={id} data-pointer={pointer} size="sm" className="h-7 w-full font-mono text-xs">
        <SelectValue placeholder={placeholder === '' ? 'unset' : placeholder} />
      </SelectTrigger>
      <SelectContent position="popper" className="min-w-(--radix-select-trigger-width)">
        {items.map((option) => (
          <SelectItem key={option} value={option} className="font-mono text-xs">
            {option}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
