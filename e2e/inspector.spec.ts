// Inspector end-to-end (brief Step 3 acceptance) against the real stack: the playground app with
// vite-plugin-ast-locator, the engine behind /@trivia/api, and the designer proxying both.
//
// The tests edit examples/playground/src/pages/Dashboard.tsx on disk and restore its original
// bytes after each test.
//
// Canvas: when the designer renders its canvas iframe, the tests click through it like a user
// and also assert the selection highlight. A build without the canvas (the inspector workstream
// is built in parallel with it) gets a stand-in instead: the test injects `<iframe src="/">`
// (same origin through the designer proxy, so HMR and contentDocument behave as in the canvas)
// plus a click hook that does what the canvas's selection does: nearest [data-ast-node],
// climbing out of uiDir, then `window.__trivia.select(locator)`
// (packages/designer/src/features/inspector/debug.ts). Prop schemas are likewise loaded
// through `window.__trivia` when no shell has loaded them. Each
// stand-in is recorded as a test annotation, so the report says which path ran.

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { expect, test, type Frame, type Locator, type Page } from '@playwright/test'

const DASHBOARD = path.resolve(import.meta.dirname, '../examples/playground/src/pages/Dashboard.tsx')
const SAVE_BUTTON = '<Button>Save changes</Button>'
const FOOTER_OPEN = '<CardFooter className="justify-end gap-2">'

/** The slice of `window.__trivia` (packages/designer/src/features/inspector/debug.ts) these tests use. */
interface DebugHandle {
  state(): {
    selected: string | null
    components: unknown[]
    history: { undoLabel: string | null }
    bumpRevision(): void
  }
  select(locator: string | null): void
  loadComponents(): Promise<number>
}

type TestWindow = Window & { __trivia?: DebugHandle; __triviaMarker?: string }

interface Designer {
  frame: Frame
  inspector: Locator
  /** True when the designer's own canvas is present; false when the test stands in for it. */
  realCanvas: boolean
}

let original = ''

test.beforeEach(async () => {
  original = await readFile(DASHBOARD, 'utf8')
  expect(original, 'Dashboard.tsx is not pristine (a previous run did not restore it?)').toContain(SAVE_BUTTON)
})

test.afterEach(async () => {
  if ((await readFile(DASHBOARD, 'utf8')) !== original) await writeFile(DASHBOARD, original)
})

async function openDesigner(page: Page): Promise<Designer> {
  const health = (await (await page.request.get('/@trivia/api/health')).json()) as { ok: boolean; data: { uiDir: string } }
  expect(health.ok, 'engine API reachable through the designer proxy').toBe(true)

  await page.goto('/__trivia/')
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  await expect(inspector.getByText('Nothing selected')).toBeVisible()

  const realCanvas = await page
    .locator('iframe')
    .first()
    .waitFor({ state: 'attached', timeout: 3_000 })
    .then(
      () => true,
      () => false,
    )
  if (!realCanvas) {
    note('stand-in canvas', 'no canvas iframe in this build: injected <iframe src="/"> and a click→select hook')
    await page.evaluate(() => {
      const iframe = document.createElement('iframe')
      iframe.src = '/'
      iframe.title = 'Test canvas'
      // Between the palette (w-60) and the inspector (w-80).
      Object.assign(iframe.style, {
        position: 'fixed',
        top: '0',
        left: '240px',
        width: 'calc(100vw - 560px)',
        height: '100vh',
        border: '0',
        zIndex: '1',
      })
      document.body.append(iframe)
    })
  }

  const handle = await page.locator('iframe').first().elementHandle()
  const frame = await handle?.contentFrame()
  if (!frame) throw new Error('canvas iframe has no content frame')
  await expect(frame.locator('[data-ast-node]').first()).toBeAttached({ timeout: 15_000 })

  if (!realCanvas) {
    await frame.evaluate((uiDir) => {
      document.addEventListener(
        'click',
        (event) => {
          let el = event.target instanceof Element ? event.target.closest('[data-ast-node]') : null
          while (el !== null && (el.getAttribute('data-ast-node') ?? '').startsWith(`${uiDir}/`)) {
            el = el.parentElement?.closest('[data-ast-node]') ?? null
          }
          if (el === null) return
          event.preventDefault()
          event.stopPropagation()
          ;(window.parent as TestWindow).__trivia?.select(el.getAttribute('data-ast-node'))
        },
        true,
      )
    }, health.data.uiDir)
  }

  // Prop schemas: the shell loads them; stand in when nothing has after a moment.
  const loaded = await page
    .waitForFunction(() => ((window as TestWindow).__trivia?.state().components.length ?? 0) > 0, null, { timeout: 2_000 })
    .then(
      () => true,
      () => false,
    )
  if (!loaded) {
    note('stand-in schema load', 'no shell loaded prop schemas: loaded them through window.__trivia.loadComponents()')
    const count = await page.evaluate(() => (window as TestWindow).__trivia?.loadComponents() ?? Promise.resolve(-1))
    expect(count, 'GET /@trivia/api/components returns the playground schemas').toBeGreaterThan(0)
  }

  return { frame, inspector, realCanvas }
}

function note(type: string, description: string): void {
  test.info().annotations.push({ type, description })
}

async function selected(page: Page): Promise<string | null> {
  return page.evaluate(() => (window as TestWindow).__trivia?.state().selected ?? null)
}

/** Click an element of the user's app where the user would: on the canvas, at `offset` in its box. */
async function clickOnCanvas(page: Page, target: Locator, offset?: { x: number; y: number }) {
  const box = await target.boundingBox()
  if (box === null) throw new Error('target has no bounding box')
  const point = offset ?? { x: box.width / 2, y: box.height / 2 }
  await page.mouse.click(box.x + point.x, box.y + point.y)
  return box
}

/** Some designer element (outside the iframe and the inspector) is drawn over `box`. */
async function expectHighlighted(page: Page, box: { x: number; y: number; width: number; height: number }) {
  await expect
    .poll(() =>
      page.evaluate((b) => {
        const near = (a: number, c: number) => Math.abs(a - c) <= 3
        return [...document.body.querySelectorAll('*')].some((el) => {
          if (el instanceof HTMLIFrameElement || el.closest('[aria-label="Inspector"]')) return false
          const r = el.getBoundingClientRect()
          return near(r.left, b.x) && near(r.top, b.y) && near(r.width, b.width) && near(r.height, b.height)
        })
      }, box),
    )
    .toBe(true)
}

async function onDisk(): Promise<string> {
  return readFile(DASHBOARD, 'utf8')
}

test('Step 3: select the Save button, set variant=outline, one attribute written, HMR re-renders', async ({ page }) => {
  const { frame, inspector, realCanvas } = await openDesigner(page)
  const save = frame.locator('[data-slot="button"]', { hasText: 'Save changes' })
  await expect(save).toBeVisible()
  await expect(save).toHaveAttribute('data-variant', 'default')
  const locator = await save.getAttribute('data-ast-node')
  expect(locator).toMatch(/^src\/pages\/Dashboard\.tsx#Dashboard#[\d.]+$/)

  // Click it on the canvas → selected (usage site) → highlighted.
  const box = await clickOnCanvas(page, save)
  await expect.poll(() => selected(page)).toBe(locator)
  if (realCanvas) {
    // Park the pointer outside the canvas first, so a hover box can't pass for the selection.
    await page.mouse.move(1, 1)
    await expectHighlighted(page, box)
  } else {
    note('highlight not asserted', 'the selection box is drawn by the canvas overlay, which this build lacks')
  }

  // The inspector shows the Button with its variant, size and className setters.
  const line = original.split('\n').findIndex((l) => l.includes(SAVE_BUTTON)) + 1
  await expect(inspector.getByRole('heading', { name: 'Button', exact: true })).toBeVisible()
  await expect(inspector.getByRole('button', { name: /^Copy source position/ })).toHaveText(`src/pages/Dashboard.tsx:${line}`)
  await expect(inspector.getByRole('navigation', { name: 'Ancestors' })).toHaveText(/Dashboard.*div.*Card.*CardFooter.*Button/)
  const variant = inspector.getByRole('combobox', { name: 'variant', exact: true })
  const size = inspector.getByRole('combobox', { name: 'size', exact: true })
  await expect(variant).toHaveText('default') // absent in source: the cva default as placeholder
  await expect(size).toHaveText('default')
  const classes = inspector.getByRole('region', { name: 'Classes' })
  await expect(classes).toContainText('className')
  await expect(classes.getByRole('textbox', { name: 'Add classes' })).toBeVisible()
  await expect(inspector.getByRole('region', { name: 'Text' })).toContainText('Save changes')
  await page.screenshot({ path: test.info().outputPath('1-selected.png'), animations: 'disabled' })

  // A full reload would lose this; HMR keeps it.
  await frame.evaluate(() => {
    ;(window as TestWindow).__triviaMarker = 'before-edit'
  })

  await variant.click()
  await expect(page.getByRole('option')).toHaveText(['default', 'outline', 'secondary', 'ghost', 'destructive', 'link'])
  await page.screenshot({ path: test.info().outputPath('2-variant-options.png'), animations: 'disabled' })
  await page.getByRole('option', { name: 'outline', exact: true }).click()

  // Exactly one attribute added; every other byte unchanged.
  const expected = original.replace(SAVE_BUTTON, '<Button variant="outline">Save changes</Button>')
  expect(expected).not.toBe(original)
  await expect.poll(onDisk).toBe(expected)

  // HMR re-rendered the button in place (no reload: the marker survived).
  await expect(save).toHaveAttribute('data-variant', 'outline')
  expect(await frame.evaluate(() => (window as TestWindow).__triviaMarker)).toBe('before-edit')

  // The inspector re-read the source and the edit is one history entry.
  await expect(variant).toHaveText('outline')
  await expect(inspector.getByRole('button', { name: 'Reset variant' })).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => (window as TestWindow).__trivia?.state().history.undoLabel ?? null))
    .toBe('Set Button.variant')
  await page.screenshot({ path: test.info().outputPath('3-variant-outline.png'), animations: 'disabled' })

  // Reset removes the attribute again: back to the original bytes.
  await inspector.getByRole('button', { name: 'Reset variant' }).click()
  await expect.poll(onDisk).toBe(original)
  await expect(save).toHaveAttribute('data-variant', 'default')
  await expect(variant).toHaveText('default')
})

test('class manager: gap-4 replaces gap-2 in place; removing a chip writes only that token', async ({ page }) => {
  const { frame, inspector, realCanvas } = await openDesigner(page)
  const footer = frame.locator('[data-slot="card-footer"]')
  const locator = await footer.getAttribute('data-ast-node')
  // The footer's empty left side, away from its buttons.
  await clickOnCanvas(page, footer, { x: 12, y: 12 })
  await expect.poll(() => selected(page)).toBe(locator)
  await expect(inspector.getByRole('heading', { name: 'CardFooter', exact: true })).toBeVisible()

  const chips = inspector.getByRole('list', { name: 'Classes' }).getByRole('listitem')
  await expect(chips).toHaveText(['justify-end', 'gap-2'])

  const input = inspector.getByRole('textbox', { name: 'Add classes' })
  await input.fill('gap-4')
  // Typing previews: gap-2 is marked as replaced, gap-4 pending; nothing is written yet.
  await expect(chips).toHaveText(['justify-end', 'gap-2', 'gap-4'])
  await expect(inspector.getByText('Replaces gap-2.')).toBeVisible()
  if (realCanvas) await expect(footer).toHaveClass(/(^|\s)gap-4(\s|$)/)
  else note('live preview not asserted', 'canvas.previewClassName is implemented by the canvas, which this build lacks')
  expect(await onDisk()).toBe(original)
  await page.screenshot({ path: test.info().outputPath('class-preview.png') })

  await input.press('Enter')
  await expect.poll(onDisk).toBe(original.replace(FOOTER_OPEN, '<CardFooter className="justify-end gap-4">'))
  await expect(footer).toHaveClass(/(^|\s)gap-4(\s|$)/) // via HMR
  await expect(chips).toHaveText(['justify-end', 'gap-4'])

  await inspector.getByRole('button', { name: 'Remove class gap-4' }).click()
  await expect.poll(onDisk).toBe(original.replace(FOOTER_OPEN, '<CardFooter className="justify-end">'))
  await expect(chips).toHaveText(['justify-end'])
})

test('generic props: edit a string prop on Enter, add a new attribute', async ({ page }) => {
  const { frame, inspector } = await openDesigner(page)
  const input = frame.locator('#name')
  await clickOnCanvas(page, input)
  await expect(inspector.getByRole('heading', { name: 'Input', exact: true })).toBeVisible()

  // `id` is written in source but not in the schema: shown as a generic editable prop.
  await expect(inspector.getByRole('textbox', { name: 'id', exact: true })).toHaveValue('name')
  const placeholder = inspector.getByRole('textbox', { name: 'placeholder', exact: true })
  await expect(placeholder).toHaveValue('my-app')

  // Typing stays local until Enter.
  await placeholder.fill('your-app')
  expect(await onDisk()).toBe(original)
  await placeholder.press('Enter')
  const renamed = original.replace('<Input id="name" placeholder="my-app" />', '<Input id="name" placeholder="your-app" />')
  await expect.poll(onDisk).toBe(renamed)
  await expect(frame.locator('#name')).toHaveAttribute('placeholder', 'your-app')

  await inspector.getByRole('button', { name: 'Add prop' }).click()
  await inspector.getByRole('textbox', { name: 'Prop name' }).fill('autoComplete')
  await inspector.getByRole('textbox', { name: 'Prop value' }).fill('off')
  await inspector.getByRole('textbox', { name: 'Prop value' }).press('Enter')
  await expect
    .poll(onDisk)
    .toBe(original.replace('<Input id="name" placeholder="my-app" />', '<Input id="name" placeholder="your-app" autoComplete="off" />'))
  await expect(inspector.getByRole('textbox', { name: 'autoComplete', exact: true })).toHaveValue('off')
  await expect(frame.locator('#name')).toHaveAttribute('autocomplete', 'off')
})

test('expression-bound props are read-only; literal props on the same element stay editable', async ({ page }) => {
  const { frame, inspector } = await openDesigner(page)
  // Rendered by plans.map(): <Badge key={plan} variant="secondary">
  await clickOnCanvas(page, frame.locator('[data-slot="badge"]', { hasText: 'Pro' }))
  await expect(inspector.getByRole('heading', { name: 'Badge', exact: true })).toBeVisible()
  await expect(inspector.getByText('in expression', { exact: true })).toBeVisible()

  await expect(inspector.getByRole('combobox', { name: 'variant', exact: true })).toHaveText('secondary')
  await expect(inspector.getByRole('button', { name: 'Reset variant' })).toBeVisible()
  // key={plan}: shown as code with the reason, no setter, no reset.
  await expect(inspector.locator('code', { hasText: /^plan$/ })).toBeVisible()
  await expect(inspector.getByText('Bound to an expression — edit in code.')).toBeVisible()
  await expect(inspector.getByRole('button', { name: 'Reset key' })).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath('expression-props.png') })
})

test('an element removed by an edit shows "Element not found", not a crash', async ({ page }) => {
  const { frame, inspector } = await openDesigner(page)
  const save = frame.locator('[data-slot="button"]', { hasText: 'Save changes' })
  await clickOnCanvas(page, save)
  await expect(inspector.getByRole('heading', { name: 'Button', exact: true })).toBeVisible()

  // Delete the button by hand, as an edit in the user's IDE would.
  const lines = original.split('\n')
  await writeFile(DASHBOARD, lines.filter((l) => !l.includes(SAVE_BUTTON)).join('\n'))
  await expect(frame.getByText('Save changes')).toHaveCount(0) // HMR applied
  // The canvas bumps the revision on HMR; doing it here too is harmless with the real canvas.
  await page.evaluate(() => (window as TestWindow).__trivia?.state().bumpRevision())

  const alert = inspector.getByRole('alert')
  await expect(alert).toContainText('Element not found')
  await page.screenshot({ path: test.info().outputPath('not-found.png') })
  await alert.getByRole('button', { name: 'Select parent' }).click()
  await expect(inspector.getByRole('heading', { name: 'CardFooter', exact: true })).toBeVisible()
})

/** Engine writes (apply/batch bodies) the page makes from now on. */
function recordWrites(page: Page): string[] {
  const writes: string[] = []
  page.on('request', (req) => {
    if (req.method() === 'POST' && /\/@trivia\/api\/(apply|batch)$/.test(new URL(req.url()).pathname)) writes.push(req.postData() ?? '')
  })
  return writes
}

const undoLabel = (page: Page) => page.evaluate(() => (window as TestWindow).__trivia?.state().history.undoLabel ?? null)

test('a value typed and left with a canvas click is written to the element it was typed for; the click still selects', async ({ page }) => {
  const { frame, inspector, realCanvas } = await openDesigner(page)
  test.skip(!realCanvas, 'needs the canvas overlay: the click must select on pointerdown, before the field blurs')
  await clickOnCanvas(page, frame.locator('#name'))
  await expect(inspector.getByRole('heading', { name: 'Input', exact: true })).toBeVisible()

  // Typed, not submitted; then the user clicks another element on the canvas.
  await inspector.getByRole('textbox', { name: 'placeholder', exact: true }).fill('your-app')
  expect(await onDisk()).toBe(original)
  const save = frame.locator('[data-slot="button"]', { hasText: 'Save changes' })
  const saveLocator = await save.getAttribute('data-ast-node')
  await clickOnCanvas(page, save)

  await expect.poll(onDisk).toBe(original.replace('<Input id="name" placeholder="my-app" />', '<Input id="name" placeholder="your-app" />'))
  await expect(frame.locator('#name')).toHaveAttribute('placeholder', 'your-app') // HMR
  await expect.poll(() => undoLabel(page)).toBe('Set Input.placeholder')
  // The write returned after the click: the selection stays where the user put it.
  expect(await selected(page)).toBe(saveLocator)
  await expect(inspector.getByRole('heading', { name: 'Button', exact: true })).toBeVisible()

  // The same for a style field, with the panel's history label.
  const footer = frame.locator('[data-slot="card-footer"]')
  await clickOnCanvas(page, footer, { x: 12, y: 12 })
  await expect(inspector.getByRole('heading', { name: 'CardFooter', exact: true })).toBeVisible()
  await inspector.getByRole('textbox', { name: 'Padding', exact: true }).fill('24')
  await clickOnCanvas(page, save)
  await expect.poll(onDisk).toContain('<CardFooter className="justify-end gap-2 p-6">')
  await expect.poll(() => undoLabel(page)).toBe('Padding p-6')
  expect(await selected(page)).toBe(saveLocator)
})

test('class manager keeps a multi-line className’s layout, and an added class survives the component’s cn()', async ({ page }) => {
  const MULTI = '<CardFooter\n          className="\n            justify-end\n            gap-2 px-2 p-4\n          "\n        >'
  await writeFile(DASHBOARD, original.replace(FOOTER_OPEN, MULTI))
  const { frame, inspector } = await openDesigner(page)
  const footer = frame.locator('[data-slot="card-footer"]')
  await expect(footer).toHaveClass(/(^|\s)p-4(\s|$)/)
  const edited = await onDisk()

  await clickOnCanvas(page, footer, { x: 12, y: 12 })
  await expect(inspector.getByRole('heading', { name: 'CardFooter', exact: true })).toBeVisible()
  const chips = inspector.getByRole('list', { name: 'Classes' }).getByRole('listitem')
  await expect(chips).toHaveText(['justify-end', 'gap-2', 'px-2', 'p-4'])

  const input = inspector.getByRole('textbox', { name: 'Add classes' })
  await input.fill('px-8')
  await expect(inspector.getByText('Replaces px-2.')).toBeVisible()
  await input.press('Enter')
  // Only the touched tokens change; the line breaks and indentation stay. px-8 goes after p-4:
  // CardFooter runs className through cn() (twMerge, later wins), where "px-8 p-4" would lose px-8.
  await expect.poll(onDisk).toBe(edited.replace('gap-2 px-2 p-4\n', 'gap-2 p-4 px-8\n'))
  await expect(footer).toHaveClass(/(^|\s)px-8(\s|$)/)

  await inspector.getByRole('button', { name: 'Remove class gap-2' }).click()
  await expect.poll(onDisk).toBe(edited.replace('            gap-2 px-2 p-4\n', '            p-4 px-8\n'))
  await expect(chips).toHaveText(['justify-end', 'p-4', 'px-8'])
})

test('undo during the slider’s keyboard settle window takes back the slider change, not the previous edit', async ({ page }) => {
  const { frame, inspector } = await openDesigner(page)
  const footer = frame.locator('[data-slot="card-footer"]')
  await clickOnCanvas(page, footer, { x: 12, y: 12 })
  await expect(inspector.getByRole('heading', { name: 'CardFooter', exact: true })).toBeVisible()

  // The previous edit: one history entry.
  const input = inspector.getByRole('textbox', { name: 'Add classes' })
  await input.fill('flex-wrap')
  await input.press('Enter')
  const withWrap = original.replace(FOOTER_OPEN, '<CardFooter className="justify-end gap-2 flex-wrap">')
  await expect.poll(onDisk).toBe(withWrap)
  await expect.poll(() => undoLabel(page)).toBe('Set CardFooter.className')
  await expect(footer).toHaveClass(/(^|\s)flex-wrap(\s|$)/)

  // A slider key change, then ⌘Z/Ctrl+Z on the focused thumb, both inside the settle window
  // (timed in the page, so test-runner round trips can't stretch it).
  const writes = recordWrites(page)
  const thumb = inspector.getByRole('slider', { name: 'Padding' })
  await thumb.focus()
  const before = await thumb.getAttribute('aria-valuenow')
  await thumb.evaluate((el) => {
    const mac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true }))
  })
  await expect(thumb).toHaveAttribute('aria-valuenow', before ?? '')
  await page.waitForTimeout(1_000) // well past the 450ms settle window
  expect(writes, writes.join('\n')).toEqual([])
  expect(await onDisk()).toBe(withWrap)
  expect(await undoLabel(page)).toBe('Set CardFooter.className')

  // Nothing pending any more: the next undo is the engine's.
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(onDisk).toBe(original)
})
