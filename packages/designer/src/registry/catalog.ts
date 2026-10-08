// How the palette organizes the user's components: one *family* per component module
// (card.tsx → Card with CardHeader, CardTitle, … as its parts), families sorted into groups,
// and a search over names and common synonyms.

import type { ComponentSchema } from '@/bridge/types'
import { type Template, templatesFor } from '@/registry/templates'

export type GroupId = 'form' | 'layout' | 'display' | 'feedback' | 'overlay' | 'navigation' | 'other'

export const GROUPS: ReadonlyArray<{ id: GroupId; label: string }> = [
  { id: 'form', label: 'Form' },
  { id: 'layout', label: 'Layout' },
  { id: 'display', label: 'Display' },
  { id: 'feedback', label: 'Feedback' },
  { id: 'overlay', label: 'Overlay' },
  { id: 'navigation', label: 'Navigation' },
  { id: 'other', label: 'Other' },
]

interface Known {
  group: GroupId
  /** Words people search for that aren't in the name. */
  keywords?: string
}

/** Known shadcn families, in the order the palette lists them within a group. */
const KNOWN: Readonly<Record<string, Known>> = {
  Button: { group: 'form', keywords: 'action submit cta' },
  ButtonGroup: { group: 'form', keywords: 'segmented buttons' },
  Input: { group: 'form', keywords: 'text field textbox' },
  InputGroup: { group: 'form', keywords: 'addon field' },
  InputOTP: { group: 'form', keywords: 'code pin one-time' },
  Textarea: { group: 'form', keywords: 'multiline text field' },
  Label: { group: 'form', keywords: 'caption text' },
  Field: { group: 'form', keywords: 'form control label' },
  Form: { group: 'form' },
  Checkbox: { group: 'form', keywords: 'tick check' },
  Switch: { group: 'form', keywords: 'toggle boolean' },
  RadioGroup: { group: 'form', keywords: 'radio option choice' },
  Select: { group: 'form', keywords: 'dropdown picker options' },
  NativeSelect: { group: 'form', keywords: 'dropdown picker options' },
  Combobox: { group: 'form', keywords: 'autocomplete dropdown' },
  Slider: { group: 'form', keywords: 'range' },
  Toggle: { group: 'form', keywords: 'pressed button' },
  ToggleGroup: { group: 'form', keywords: 'segmented' },
  Calendar: { group: 'form', keywords: 'date picker' },

  Card: { group: 'layout', keywords: 'panel container box' },
  Separator: { group: 'layout', keywords: 'divider hr rule line' },
  Tabs: { group: 'layout', keywords: 'tab panel' },
  Accordion: { group: 'layout', keywords: 'disclosure expand collapse' },
  Collapsible: { group: 'layout', keywords: 'disclosure expand collapse' },
  ScrollArea: { group: 'layout', keywords: 'overflow scroll' },
  AspectRatio: { group: 'layout', keywords: 'ratio media' },
  Resizable: { group: 'layout', keywords: 'split panes' },
  Sidebar: { group: 'layout', keywords: 'nav drawer' },

  Badge: { group: 'display', keywords: 'tag chip pill label' },
  Avatar: { group: 'display', keywords: 'profile user image' },
  Table: { group: 'display', keywords: 'grid rows data' },
  Kbd: { group: 'display', keywords: 'keyboard shortcut key' },
  Item: { group: 'display', keywords: 'list row' },
  Empty: { group: 'display', keywords: 'empty state placeholder' },
  Carousel: { group: 'display', keywords: 'slides slider gallery' },
  Chart: { group: 'display', keywords: 'graph plot' },

  Alert: { group: 'feedback', keywords: 'callout notice banner warning' },
  Progress: { group: 'feedback', keywords: 'loading bar' },
  Skeleton: { group: 'feedback', keywords: 'loading placeholder shimmer' },
  Spinner: { group: 'feedback', keywords: 'loading loader' },
  Toaster: { group: 'feedback', keywords: 'toast notification sonner' },

  Dialog: { group: 'overlay', keywords: 'modal popup' },
  AlertDialog: { group: 'overlay', keywords: 'confirm modal' },
  Sheet: { group: 'overlay', keywords: 'drawer side panel' },
  Drawer: { group: 'overlay', keywords: 'sheet bottom panel' },
  Popover: { group: 'overlay', keywords: 'popup floating' },
  HoverCard: { group: 'overlay', keywords: 'popover preview' },
  Tooltip: { group: 'overlay', keywords: 'hint title' },
  DropdownMenu: { group: 'overlay', keywords: 'menu actions' },
  ContextMenu: { group: 'overlay', keywords: 'right click menu' },
  Command: { group: 'overlay', keywords: 'palette search cmdk' },

  Breadcrumb: { group: 'navigation', keywords: 'path trail' },
  Pagination: { group: 'navigation', keywords: 'pages pager' },
  NavigationMenu: { group: 'navigation', keywords: 'nav menu' },
  Menubar: { group: 'navigation', keywords: 'menu bar' },
}

const ORDER = new Map(Object.keys(KNOWN).map((name, i) => [name, i]))

export interface PaletteItem {
  schema: ComponentSchema
  template: Template
}

/** A component module: its primary component and the parts exported next to it. */
export interface Family {
  /** The module's file, unique per family. */
  key: string
  primary: PaletteItem
  parts: PaletteItem[]
  /** Components in the module, whether or not a search hides some parts. */
  size: number
}

export interface PaletteGroup {
  id: GroupId
  label: string
  families: Family[]
}

/** Families of `components`, grouped and ordered for the palette. */
export function buildCatalog(components: ComponentSchema[]): PaletteGroup[] {
  const templates = templatesFor(components)
  const byFile = new Map<string, PaletteItem[]>()
  components.forEach((schema, i) => {
    const template = templates[i]
    if (template === undefined) return
    byFile.set(schema.file, [...(byFile.get(schema.file) ?? []), { schema, template }])
  })

  const groups = new Map<GroupId, Family[]>()
  for (const [file, items] of byFile) {
    const primary = primaryOf(file, items)
    const family: Family = { key: file, primary, parts: items.filter((item) => item !== primary), size: items.length }
    const group = KNOWN[primary.schema.name]?.group ?? 'other'
    groups.set(group, [...(groups.get(group) ?? []), family])
  }

  return GROUPS.flatMap(({ id, label }) => {
    const families = groups.get(id)
    if (families === undefined) return []
    families.sort(compareFamilies)
    return [{ id, label, families }]
  })
}

/**
 * Narrow the catalog to `query`. A family stays when its primary matches (all parts kept)
 * or when some parts match (only those kept); `expanded` lists families shown open
 * because a part matched.
 */
export function filterCatalog(groups: PaletteGroup[], query: string): { groups: PaletteGroup[]; expanded: Set<string> } {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const expanded = new Set<string>()
  if (terms.length === 0) return { groups, expanded }

  const matches = (item: PaletteItem, extra: string) => {
    const haystack = `${item.schema.name} ${splitWords(item.schema.name)} ${extra}`.toLowerCase()
    return terms.every((t) => haystack.includes(t))
  }

  const result: PaletteGroup[] = []
  for (const group of groups) {
    const families: Family[] = []
    for (const family of group.families) {
      const known = KNOWN[family.primary.schema.name]
      if (matches(family.primary, `${known?.keywords ?? ''} ${group.label}`)) {
        families.push(family)
        continue
      }
      const parts = family.parts.filter((part) => matches(part, ''))
      if (parts.length > 0) {
        families.push({ ...family, parts })
        expanded.add(family.key)
      }
    }
    if (families.length > 0) result.push({ ...group, families })
  }
  return { groups: result, expanded }
}

export function countComponents(groups: PaletteGroup[]): number {
  return groups.reduce((n, g) => n + g.families.reduce((m, f) => m + 1 + f.parts.length, 0), 0)
}

/** `card.tsx` → Card, `dropdown-menu.tsx` → DropdownMenu; else the module's first export. */
function primaryOf(file: string, items: PaletteItem[]): PaletteItem {
  const base = file.split('/').pop()?.replace(/\.[jt]sx?$/, '') ?? ''
  // Case-insensitive, so input-otp.tsx finds InputOTP.
  const expected = base.replace(/[-_.]/g, '').toLowerCase()
  return items.find((item) => item.schema.name.toLowerCase() === expected) ?? (items[0] as PaletteItem)
}

function compareFamilies(a: Family, b: Family): number {
  const ia = ORDER.get(a.primary.schema.name) ?? Number.MAX_SAFE_INTEGER
  const ib = ORDER.get(b.primary.schema.name) ?? Number.MAX_SAFE_INTEGER
  return ia - ib || a.primary.schema.name.localeCompare(b.primary.schema.name)
}

/** `DropdownMenuItem` → `dropdown menu item`, so "menu item" finds it. */
function splitWords(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
}
