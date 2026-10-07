import { cn } from '@/lib/utils'

/**
 * The Trivia mark: the "visible space" glyph (␣). In compiler terms trivia is the whitespace
 * and comments a normal AST round-trip throws away, which is exactly what Trivia keeps.
 */
export function TriviaMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={cn('size-5', className)}>
      <rect width="24" height="24" rx="6" className="fill-foreground" />
      <path
        d="M6.5 10.5v4h11v-4"
        fill="none"
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-background"
      />
    </svg>
  )
}

export function Brand() {
  return (
    <div className="flex shrink-0 items-center gap-2 pl-1">
      <TriviaMark />
      <span className="text-sm font-semibold tracking-tight">Trivia</span>
    </div>
  )
}
