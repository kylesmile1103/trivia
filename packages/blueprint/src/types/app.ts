// The app document, `app.blueprint.json` (LLD-01 section 2). Property order here is the order
// the canonical serializer writes; a `.default()` is omitted from the file when equal.
import { z } from 'zod'

import { ICON, SCHEMA_URL, TOKEN, pageName } from './common.js'

export const WEB_TARGETS = ['vite-refine', 'next-refine'] as const
export const API_TARGETS = ['dotnet-minimal'] as const
export const AUTH_MODES = ['none', 'oidc'] as const

export const navEntrySchema = z.strictObject({
  page: pageName,
  label: z.string().min(1),
  icon: z.string().regex(ICON).optional(),
})

export const appSchema = z.strictObject({
  $schema: z.literal(SCHEMA_URL.app),
  blueprintVersion: z.literal(1),
  name: pageName,
  targets: z.strictObject({
    web: z.enum(WEB_TARGETS),
    api: z.enum(API_TARGETS).optional(),
  }),
  auth: z.strictObject({ mode: z.enum(AUTH_MODES) }).default(() => ({ mode: 'none' as const })),
  theme: z.strictObject({ tokens: z.record(z.string().regex(TOKEN), z.string().min(1)) }).default(() => ({ tokens: {} })),
  nav: z.array(navEntrySchema).default(() => []),
})

export type AppDoc = z.output<typeof appSchema>
export type NavEntry = z.output<typeof navEntrySchema>
