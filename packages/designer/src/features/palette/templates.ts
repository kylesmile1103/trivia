// Drag-and-drop templates for components found in the user's src/components/ui.
//
// A template is what the palette inserts: one JSX element and the imports it needs. Common
// shadcn components get a curated recipe with good default markup (a Card with header,
// title, description and content; a complete Select). A recipe's imports are derived from
// the tags it references, resolved against the user's analyzed components, so it is only
// offered when every component it uses exists; otherwise the component gets a generic
// one-element template.
//
// Snippets are written unindented at the root, with two-space nesting: the engine re-indents
// every line onto the insertion point and keeps the relative indentation.

import type { ComponentSchema, ImportSpec, JsonValue, PropSchema } from '@/shared/engine/types'
import type { Template } from '@/shared/template'

/** Curated markup keyed by the primary component; the snippet's root is always that component. */
export const RECIPES: Readonly<Record<string, string>> = {
  // Form
  Button: '<Button>Button</Button>',
  Input: '<Input placeholder="Enter a value" />',
  Textarea: '<Textarea placeholder="Type your message here." />',
  Label: '<Label>Label</Label>',
  Checkbox: '<Checkbox />',
  Switch: '<Switch />',
  Select: lines(
    '<Select>',
    '  <SelectTrigger className="w-48">',
    '    <SelectValue placeholder="Select an option" />',
    '  </SelectTrigger>',
    '  <SelectContent>',
    '    <SelectItem value="option-1">Option 1</SelectItem>',
    '    <SelectItem value="option-2">Option 2</SelectItem>',
    '    <SelectItem value="option-3">Option 3</SelectItem>',
    '  </SelectContent>',
    '</Select>',
  ),
  RadioGroup: lines(
    '<RadioGroup defaultValue="option-1">',
    '  <Label>',
    '    <RadioGroupItem value="option-1" />',
    '    Option 1',
    '  </Label>',
    '  <Label>',
    '    <RadioGroupItem value="option-2" />',
    '    Option 2',
    '  </Label>',
    '</RadioGroup>',
  ),
  Slider: '<Slider defaultValue={[50]} max={100} step={1} />',
  Toggle: '<Toggle aria-label="Toggle bold">Bold</Toggle>',
  ToggleGroup: lines(
    '<ToggleGroup type="single" defaultValue="left">',
    '  <ToggleGroupItem value="left">Left</ToggleGroupItem>',
    '  <ToggleGroupItem value="center">Center</ToggleGroupItem>',
    '  <ToggleGroupItem value="right">Right</ToggleGroupItem>',
    '</ToggleGroup>',
  ),
  ButtonGroup: lines(
    '<ButtonGroup>',
    '  <Button variant="outline">First</Button>',
    '  <Button variant="outline">Second</Button>',
    '</ButtonGroup>',
  ),

  // Layout
  Card: lines(
    '<Card>',
    '  <CardHeader>',
    '    <CardTitle>Title</CardTitle>',
    '    <CardDescription>Description</CardDescription>',
    '  </CardHeader>',
    '  <CardContent>Content</CardContent>',
    '</Card>',
  ),
  Separator: '<Separator />',
  Tabs: lines(
    '<Tabs defaultValue="account">',
    '  <TabsList>',
    '    <TabsTrigger value="account">Account</TabsTrigger>',
    '    <TabsTrigger value="password">Password</TabsTrigger>',
    '  </TabsList>',
    '  <TabsContent value="account">Account settings.</TabsContent>',
    '  <TabsContent value="password">Password settings.</TabsContent>',
    '</Tabs>',
  ),
  Accordion: lines(
    '<Accordion type="single" collapsible>',
    '  <AccordionItem value="item-1">',
    '    <AccordionTrigger>Is it accessible?</AccordionTrigger>',
    '    <AccordionContent>Yes. It follows the WAI-ARIA design pattern.</AccordionContent>',
    '  </AccordionItem>',
    '</Accordion>',
  ),
  Collapsible: lines(
    '<Collapsible>',
    '  <CollapsibleTrigger>Show more</CollapsibleTrigger>',
    '  <CollapsibleContent>Hidden content.</CollapsibleContent>',
    '</Collapsible>',
  ),
  ScrollArea: '<ScrollArea className="h-48 rounded-md border p-4">Content</ScrollArea>',
  AspectRatio: '<AspectRatio ratio={16 / 9}>Content</AspectRatio>',

  // Display
  Badge: '<Badge>Badge</Badge>',
  Avatar: lines('<Avatar>', '  <AvatarFallback>CN</AvatarFallback>', '</Avatar>'),
  Table: lines(
    '<Table>',
    '  <TableHeader>',
    '    <TableRow>',
    '      <TableHead>Name</TableHead>',
    '      <TableHead>Status</TableHead>',
    '    </TableRow>',
    '  </TableHeader>',
    '  <TableBody>',
    '    <TableRow>',
    '      <TableCell>Item</TableCell>',
    '      <TableCell>Active</TableCell>',
    '    </TableRow>',
    '  </TableBody>',
    '</Table>',
  ),
  Kbd: '<Kbd>K</Kbd>',

  // Feedback
  Alert: lines(
    '<Alert>',
    '  <AlertTitle>Heads up!</AlertTitle>',
    '  <AlertDescription>You can add components to your app.</AlertDescription>',
    '</Alert>',
  ),
  Progress: '<Progress value={50} />',
  Skeleton: '<Skeleton className="h-4 w-48" />',

  // Overlay
  Dialog: lines(
    '<Dialog>',
    '  <DialogTrigger asChild>',
    '    <Button variant="outline">Open dialog</Button>',
    '  </DialogTrigger>',
    '  <DialogContent>',
    '    <DialogHeader>',
    '      <DialogTitle>Dialog title</DialogTitle>',
    '      <DialogDescription>Dialog description.</DialogDescription>',
    '    </DialogHeader>',
    '  </DialogContent>',
    '</Dialog>',
  ),
  AlertDialog: lines(
    '<AlertDialog>',
    '  <AlertDialogTrigger asChild>',
    '    <Button variant="outline">Delete</Button>',
    '  </AlertDialogTrigger>',
    '  <AlertDialogContent>',
    '    <AlertDialogHeader>',
    '      <AlertDialogTitle>Are you sure?</AlertDialogTitle>',
    '      <AlertDialogDescription>This action cannot be undone.</AlertDialogDescription>',
    '    </AlertDialogHeader>',
    '    <AlertDialogFooter>',
    '      <AlertDialogCancel>Cancel</AlertDialogCancel>',
    '      <AlertDialogAction>Continue</AlertDialogAction>',
    '    </AlertDialogFooter>',
    '  </AlertDialogContent>',
    '</AlertDialog>',
  ),
  Sheet: lines(
    '<Sheet>',
    '  <SheetTrigger asChild>',
    '    <Button variant="outline">Open sheet</Button>',
    '  </SheetTrigger>',
    '  <SheetContent>',
    '    <SheetHeader>',
    '      <SheetTitle>Sheet title</SheetTitle>',
    '      <SheetDescription>Sheet description.</SheetDescription>',
    '    </SheetHeader>',
    '  </SheetContent>',
    '</Sheet>',
  ),
  Popover: lines(
    '<Popover>',
    '  <PopoverTrigger asChild>',
    '    <Button variant="outline">Open popover</Button>',
    '  </PopoverTrigger>',
    '  <PopoverContent>Popover content.</PopoverContent>',
    '</Popover>',
  ),
  HoverCard: lines(
    '<HoverCard>',
    '  <HoverCardTrigger>Hover me</HoverCardTrigger>',
    '  <HoverCardContent>Details.</HoverCardContent>',
    '</HoverCard>',
  ),
  DropdownMenu: lines(
    '<DropdownMenu>',
    '  <DropdownMenuTrigger asChild>',
    '    <Button variant="outline">Open menu</Button>',
    '  </DropdownMenuTrigger>',
    '  <DropdownMenuContent>',
    '    <DropdownMenuLabel>My account</DropdownMenuLabel>',
    '    <DropdownMenuSeparator />',
    '    <DropdownMenuItem>Profile</DropdownMenuItem>',
    '    <DropdownMenuItem>Settings</DropdownMenuItem>',
    '  </DropdownMenuContent>',
    '</DropdownMenu>',
  ),

  // Navigation
  Breadcrumb: lines(
    '<Breadcrumb>',
    '  <BreadcrumbList>',
    '    <BreadcrumbItem>',
    '      <BreadcrumbLink href="#">Home</BreadcrumbLink>',
    '    </BreadcrumbItem>',
    '    <BreadcrumbSeparator />',
    '    <BreadcrumbItem>',
    '      <BreadcrumbPage>Current page</BreadcrumbPage>',
    '    </BreadcrumbItem>',
    '  </BreadcrumbList>',
    '</Breadcrumb>',
  ),
  Pagination: lines(
    '<Pagination>',
    '  <PaginationContent>',
    '    <PaginationItem>',
    '      <PaginationPrevious href="#" />',
    '    </PaginationItem>',
    '    <PaginationItem>',
    '      <PaginationLink href="#" isActive>',
    '        1',
    '      </PaginationLink>',
    '    </PaginationItem>',
    '    <PaginationItem>',
    '      <PaginationNext href="#" />',
    '    </PaginationItem>',
    '  </PaginationContent>',
    '</Pagination>',
  ),
}

/** One template per component: its recipe when every part resolves, else a generic one. */
export function templatesFor(components: ComponentSchema[]): Template[] {
  const byName = new Map<string, ComponentSchema[]>()
  for (const c of components) byName.set(c.name, [...(byName.get(c.name) ?? []), c])
  return components.map((c) => curatedTemplate(c, byName) ?? genericTemplate(c))
}

/** Whether `template` is the curated recipe (rather than the generic fallback). */
export function isCurated(template: Template): boolean {
  return RECIPES[template.component] === template.snippet
}

/**
 * Root names of the components a snippet references, in order of first use: `<Card>` and
 * `<Foo.Bar>` (→ `Foo`) count; intrinsic tags, closing tags and fragments don't.
 */
export function componentRefs(snippet: string): string[] {
  const names = new Set<string>()
  for (const match of snippet.matchAll(/<([A-Z][\w$]*)/g)) {
    if (match[1] !== undefined) names.add(match[1])
  }
  return [...names]
}

function curatedTemplate(primary: ComponentSchema, byName: Map<string, ComponentSchema[]>): Template | null {
  const snippet = RECIPES[primary.name]
  if (snippet === undefined) return null
  const imports: ImportSpec[] = []
  for (const name of componentRefs(snippet)) {
    const schema = name === primary.name ? primary : resolvePart(name, primary, byName)
    if (schema === undefined) return null
    imports.push({ name, source: schema.importSource })
  }
  return { component: primary.name, label: primary.name, snippet, imports }
}

/** A part is taken from the primary's own module when it has one of that name (CardHeader from card.tsx). */
function resolvePart(
  name: string,
  primary: ComponentSchema,
  byName: Map<string, ComponentSchema[]>,
): ComponentSchema | undefined {
  const candidates = byName.get(name) ?? []
  return candidates.find((c) => c.file === primary.file) ?? candidates[0]
}

/** `<X>X</X>` (or `<X />`), plus a placeholder for each required prop the analyzer reports. */
function genericTemplate(c: ComponentSchema): Template {
  const attrs = c.props.flatMap((p) => {
    const attr = p.optional ? null : requiredAttr(p)
    return attr === null ? [] : [attr]
  })
  const open = [c.name, ...attrs].join(' ')
  const snippet = c.acceptsChildren ? `<${open}>${c.name}</${c.name}>` : `<${open} />`
  return { component: c.name, label: c.name, snippet, imports: [{ name: c.name, source: c.importSource }] }
}

/** JSX for a required prop, or null when no sensible placeholder exists (className, unknown types). */
function requiredAttr(p: PropSchema): string | null {
  const fallback: JsonValue | undefined = p.default
  switch (p.kind) {
    case 'enum': {
      const value = typeof fallback === 'string' ? fallback : p.options[0]
      return value === undefined ? null : `${p.name}=${jsxString(value)}`
    }
    case 'string':
      return `${p.name}=${jsxString(typeof fallback === 'string' ? fallback : p.name)}`
    case 'number':
      return `${p.name}={${typeof fallback === 'number' ? fallback : 0}}`
    case 'boolean':
      return fallback === false ? `${p.name}={false}` : p.name
    case 'className':
    case 'unknown':
      return null
  }
}

/** A JSX attribute string. JSX has no backslash escapes, but HTML entities work. */
function jsxString(value: string): string {
  return `"${value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"`
}

function lines(...rows: string[]): string {
  return rows.join('\n')
}
