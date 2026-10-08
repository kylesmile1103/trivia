// The Tailwind theme values the converter and parser need. Defaults are Tailwind v4's own
// (`tailwindcss/theme.css`, 4.3).
//
// Named scales are theme-dependent, and shadcn projects override them: `@theme inline
// { --radius-lg: var(--radius) }` makes `rounded-lg` 0.625rem instead of 0.5rem, and with
// `inline` the variable is not even emitted, so the canvas cannot read it back. So a caller
// that does not know the project's theme should map lengths to named tokens only through a
// theme it trusts (see `SCALE_ONLY_THEME`) and let users pick named tokens explicitly.

/** px per rem. Tailwind's rem-based scales assume the browser default root font size. */
export const ROOT_FONT_SIZE_PX = 16

export interface TailwindTheme {
  /** One spacing unit (`--spacing`) in px: `p-1`. Tailwind v4: 0.25rem = 4px. */
  readonly spacingPx: number
  /** Largest bare spacing multiplier written (`p-96`); larger values become arbitrary. */
  readonly spacingMax: number
  /** `rounded-<name>` → CSS length. Lengths that match exactly become the token. */
  readonly radius: Readonly<Record<string, string>>
  /** `text-<name>` → CSS length. Lengths that match exactly become the token. */
  readonly fontSize: Readonly<Record<string, string>>
}

export const DEFAULT_THEME: TailwindTheme = {
  spacingPx: 4,
  spacingMax: 96,
  radius: {
    xs: '0.125rem',
    sm: '0.25rem',
    md: '0.375rem',
    lg: '0.5rem',
    xl: '0.75rem',
    '2xl': '1rem',
    '3xl': '1.5rem',
    '4xl': '2rem',
  },
  fontSize: {
    xs: '0.75rem',
    sm: '0.875rem',
    base: '1rem',
    lg: '1.125rem',
    xl: '1.25rem',
    '2xl': '1.5rem',
    '3xl': '1.875rem',
    '4xl': '2.25rem',
    '5xl': '3rem',
    '6xl': '3.75rem',
    '7xl': '4.5rem',
    '8xl': '6rem',
    '9xl': '8rem',
  },
}

/**
 * The spacing scale only: lengths never turn into radius or font-size tokens, so typed values
 * are written exactly (`rounded-[10px]`) whatever the project's theme says `rounded-lg` is.
 */
export const SCALE_ONLY_THEME: TailwindTheme = { ...DEFAULT_THEME, radius: {}, fontSize: {} }

/** `font-<name>` ↔ numeric weight. Fixed in practice, so not part of the theme. */
export const FONT_WEIGHTS = {
  thin: 100,
  extralight: 200,
  light: 300,
  normal: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
  extrabold: 800,
  black: 900,
} as const satisfies Record<string, number>

export type FontWeightName = keyof typeof FONT_WEIGHTS

/** `w-<name>` container sizes (`--container-*`), recognised when parsing. */
export const CONTAINER_SIZES = ['3xs', '2xs', 'xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl', '7xl'] as const
