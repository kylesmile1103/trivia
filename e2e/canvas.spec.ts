// Canvas end-to-end: the real playground app inside the designer, driven with real mouse and
// keyboard input over the overlay. Edits go through the engine to disk; every test restores
// the playground files it touched.

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import { type FrameLocator, type Locator, type Page, type Route, expect, test } from '@playwright/test'

import { restore, writeWhole } from './files'

const DASHBOARD = fileURLToPath(new URL('../examples/playground/src/pages/Dashboard.tsx', import.meta.url))
const original = fs.readFileSync(DASHBOARD, 'utf8')

test.afterEach(async () => {
  restore(DASHBOARD, original)
})

const app = (page: Page): FrameLocator => page.frameLocator('iframe[title="App canvas"]')
const dashboard = () => fs.readFileSync(DASHBOARD, 'utf8')

/**
 * Open the designer with the canvas ready. The shell workstream loads `health` and `components`
 * into the store; until it lands (or if it hasn't yet), do what it does.
 */
async function openCanvas(page: Page): Promise<void> {
  await page.goto('/__trivia/')
  await storeCall(
    page,
    `const s = designer.getState()
     const get = async (path) => { const r = await fetch('/@trivia/api/' + path).then((res) => res.json()); if (!r.ok) throw new Error(r.error.message); return r.data }
     if (!s.health) s.setHealth(await get('health'))
     if (s.components.length === 0) s.setComponents(await get('components'))`,
  )
  await expect(app(page).getByRole('button', { name: 'Save changes' })).toBeVisible()
}

/** Run `body` in the page with the designer's store module (same module instance the app uses). */
function storeCall<T>(page: Page, body: string): Promise<T> {
  return page.evaluate(`(async () => {
    const { designer } = await import('/__trivia/src/shared/state/store.ts')
    const { canvas } = await import('/__trivia/src/shared/canvas.ts')
    ${body}
  })()`) as Promise<T>
}

async function box(locator: Locator) {
  const b = await locator.boundingBox()
  if (!b) throw new Error(`no box for ${locator}`)
  return b
}

const center = (b: { x: number; y: number; width: number; height: number }) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 })

/** Every op the page sends to the engine's apply endpoint, in order. */
function recordOps(page: Page): Array<Record<string, unknown>> {
  const ops: Array<Record<string, unknown>> = []
  page.on('request', (req) => {
    if (req.method() === 'POST' && new URL(req.url()).pathname === '/@trivia/api/apply') ops.push(req.postDataJSON().op)
  })
  return ops
}

const applied = (page: Page) => page.waitForResponse((res) => new URL(res.url()).pathname === '/@trivia/api/apply')

/**
 * Hold Vite's hot update of Dashboard.tsx (its `?t=` re-import), so the canvas keeps rendering
 * the pre-edit DOM until the test lets it through, or fails it as a page that reloads would.
 */
async function holdHotUpdate(page: Page) {
  const pattern = /\/src\/pages\/Dashboard\.tsx\?(?:import&)?t=\d+/
  let decide: (how: 'continue' | 'abort') => void = () => {}
  const decided = new Promise<'continue' | 'abort'>((resolve) => (decide = resolve))
  let arrived: () => void = () => {}
  /** Vite has seen the change and the app asked for the update: it is now being held. */
  const held = new Promise<void>((resolve) => (arrived = resolve))
  const handler = async (route: Route) => {
    arrived()
    const how = await decided
    // The document that asked may be gone (reloaded) by then.
    await (how === 'continue' ? route.continue() : route.abort()).catch(() => {})
  }
  await page.route(pattern, handler)
  const end = async (how: 'continue' | 'abort') => {
    decide(how)
    await page.unroute(pattern, handler)
  }
  return { held, release: () => end('continue'), fail: () => end('abort') }
}

/** The overlay box must sit exactly on the element (sub-pixel tolerance). */
async function expectSameRect(overlayBox: Locator, element: Locator) {
  await expect
    .poll(async () => {
      const [a, b] = [await overlayBox.boundingBox(), await element.boundingBox()]
      if (!a || !b) return Infinity
      return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.width - b.width), Math.abs(a.height - b.height))
    })
    .toBeLessThan(0.75)
}

test('hover and selection boxes match the element, with name and size', async ({ page }) => {
  await openCanvas(page)
  const save = app(page).getByRole('button', { name: 'Save changes' })
  const saveBox = await box(save)
  await page.mouse.move(center(saveBox).x, center(saveBox).y)

  const hover = page.locator('[data-canvas-box="hover"]')
  await expect(hover).toHaveCount(1)
  await expectSameRect(hover, save)
  await expect(page.getByTestId('canvas-hover-label')).toHaveText(
    `Button${Math.round(saveBox.width)} × ${Math.round(saveBox.height)}`,
  )

  await page.mouse.down()
  await page.mouse.up()
  const selection = page.locator('[data-canvas-box="selection"]')
  await expect(selection).toHaveCount(1)
  await expectSameRect(selection, save)
  await expect(hover).toHaveCount(0) // hovering the selection draws only the selection
  await expect(selection).toHaveAttribute('data-locator', (await save.getAttribute('data-ast-node'))!)

  // Several DOM nodes share one locator (.map()): all of them are outlined.
  const pro = app(page).getByText('Pro', { exact: true })
  const proBox = await box(pro)
  await page.mouse.move(proBox.x + 4, proBox.y + 4)
  await expect(hover).toHaveCount(3)

  // A library internal (the Switch thumb, definition-site locator) climbs to the usage site.
  const thumb = app(page).locator('[data-slot="switch-thumb"]')
  await page.mouse.click(center(await box(thumb)).x, center(await box(thumb)).y)
  const switchRoot = app(page).locator('[data-slot="switch"]')
  await expect(selection).toHaveAttribute('data-locator', (await switchRoot.getAttribute('data-ast-node'))!)
  await expect(selection).toHaveAttribute('data-locator', /^src\/pages\/Dashboard\.tsx#/)

  // Keyboard: ArrowUp selects the parent, Escape deselects.
  await page.keyboard.press('ArrowUp')
  const row = switchRoot.locator('xpath=..')
  await expect(selection).toHaveAttribute('data-locator', (await row.getAttribute('data-ast-node'))!)
  await expectSameRect(selection, row)
  await page.keyboard.press('Escape')
  await expect(selection).toHaveCount(0)
})

test('Delete removes the selected Button from the source; undo restores it', async ({ page }) => {
  await openCanvas(page)
  const save = app(page).getByRole('button', { name: 'Save changes' })
  await page.mouse.click(center(await box(save)).x, center(await box(save)).y)
  await expect(page.locator('[data-canvas-box="selection"]')).toHaveCount(1)

  await page.keyboard.press('Delete')
  await expect.poll(dashboard).not.toContain('Save changes')
  expect(dashboard()).toBe(original.replace('\n          <Button>Save changes</Button>', ''))
  await expect(save).toHaveCount(0) // HMR re-rendered the canvas
  await expect(page.locator('[data-canvas-box="selection"]')).toHaveCount(0)

  const undo = await page.request.post('/@trivia/api/undo', { data: {} })
  expect((await undo.json()).ok).toBe(true)
  expect(dashboard()).toBe(original)
  await expect(save).toBeVisible()
})

test('a click and Delete before an edit has rendered are refused, not applied to whatever now sits at that position', async ({ page }) => {
  await openCanvas(page)
  const ops = recordOps(page)
  const overlay = page.getByTestId('canvas-overlay')
  const selection = page.locator('[data-canvas-box="selection"]')
  // CardContent's three children are all <div>s: only their positions tell them apart.
  const input = app(page).getByPlaceholder('my-app')
  const nameField = input.locator('xpath=..')
  const publicRow = app(page).locator('[data-slot="card-content"] > div', { has: app(page).locator('#public') })
  await page.mouse.click(center(await box(input)).x, center(await box(input)).y)
  await page.keyboard.press('ArrowUp')
  await expect(selection).toHaveAttribute('data-locator', (await nameField.getAttribute('data-ast-node'))!)

  const hot = await holdHotUpdate(page)
  const deleted = applied(page)
  await page.keyboard.press('Delete')
  await deleted
  const afterDelete = dashboard()
  expect(afterDelete).not.toContain('placeholder="my-app"')

  // The canvas still shows the name field, so the "Public" row there carries the locator that
  // now belongs to the plans row in source. Clicking it and pressing Delete must do nothing.
  const stale = center(await box(publicRow))
  await page.mouse.click(stale.x, stale.y)
  await page.keyboard.press('Delete')
  await page.waitForTimeout(300)
  expect(dashboard()).toBe(afterDelete)
  expect(ops).toHaveLength(1)
  await expect(overlay).toHaveAttribute('aria-busy', 'true')

  // Once HMR has rendered, the same gesture deletes the row the user clicked.
  await hot.release()
  await expect(input).toHaveCount(0)
  await expect(overlay).not.toHaveAttribute('aria-busy')
  const row = center(await box(publicRow))
  await page.mouse.click(row.x, row.y)
  const rowLoc = (await publicRow.getAttribute('data-ast-node'))!
  await expect(selection).toHaveAttribute('data-locator', rowLoc)
  await page.keyboard.press('Delete')
  await expect.poll(dashboard).not.toContain('htmlFor="public"')
  expect(dashboard()).toContain('plans.map')
  expect(ops.at(-1)).toEqual({ op: 'remove', target: rowLoc, expectedName: 'div' })
})

test('a full reload while an edit renders lets go of the old selection box', async ({ page }) => {
  await openCanvas(page)
  const save = app(page).getByRole('button', { name: 'Save changes' })
  const selection = page.locator('[data-canvas-box="selection"]')
  await page.mouse.click(center(await box(save)).x, center(await box(save)).y)
  await expect(selection).toHaveCount(1)

  const hot = await holdHotUpdate(page)
  const deleted = applied(page)
  await page.keyboard.press('Delete')
  await deleted
  // The hot update fails and the app reloads instead (a module that isn't a Fast Refresh
  // boundary, or a dependency Vite had to re-optimize). Reloading before Vite has even seen
  // the change would just load the old module again.
  await hot.held
  await hot.fail()
  await page.locator('iframe[title="App canvas"]').evaluate((iframe: HTMLIFrameElement) => iframe.contentWindow?.location.reload())
  await expect(save).toHaveCount(0)
  await expect(selection).toHaveCount(0) // nothing is selected: the box of the deleted button must go

  // And the canvas takes input again.
  const cancel = app(page).getByRole('button', { name: 'Cancel' })
  await page.mouse.click(center(await box(cancel)).x, center(await box(cancel)).y)
  await expect(selection).toHaveAttribute('data-locator', (await cancel.getAttribute('data-ast-node'))!)
  await expectSameRect(selection, cancel)
})

/**
 * Milliseconds, timed in the page, from when the designer heard back from the engine's last
 * apply (or from now, if `sinceAnswer` is false) until the overlay stops being busy; capped at
 * 5 s (returns Infinity).
 */
function busyFor(page: Page, sinceAnswer: boolean): Promise<number> {
  return page.evaluate(
    (sinceAnswer) =>
      new Promise<number>((resolve) => {
        const w = window as Window & { __answeredAt?: number }
        const overlay = document.querySelector('[data-testid="canvas-overlay"]')!
        const start = performance.now()
        const check = () => {
          const from = sinceAnswer ? w.__answeredAt : start
          if (from !== undefined && !overlay.hasAttribute('aria-busy')) resolve(performance.now() - from)
          else if (performance.now() - start > 5_000) resolve(Infinity)
          else requestAnimationFrame(check)
        }
        check()
      }),
    sinceAnswer,
  )
}

/** Record (as `window.__answeredAt`, page time) when the designer receives an apply's answer. */
async function timeAnswers(page: Page) {
  await page.evaluate(() => {
    const w = window as Window & { __answeredAt?: number }
    const fetch = window.fetch
    window.fetch = async (...args: Parameters<typeof fetch>) => {
      const res = await fetch(...args)
      if (String(args[0]).endsWith('/@trivia/api/apply')) w.__answeredAt = performance.now()
      return res
    }
  })
}

test('a click while an edit renders is kept: it selects once the app has rendered', async ({ page }) => {
  await openCanvas(page)
  const ops = recordOps(page)
  const overlay = page.getByTestId('canvas-overlay')
  const selection = page.locator('[data-canvas-box="selection"]')
  const save = app(page).getByRole('button', { name: 'Save changes' })
  const title = app(page).getByText('Project settings')
  await page.mouse.click(center(await box(save)).x, center(await box(save)).y)
  await expect(selection).toHaveCount(1)

  const hot = await holdHotUpdate(page)
  const deleted = applied(page)
  await page.keyboard.press('Delete')
  await deleted
  await hot.held
  // The canvas still shows the deleted button. A click now neither acts on that old render nor
  // gets lost: it waits. (The title sits above the edit, so it keeps its place.)
  const at = center(await box(title))
  await page.mouse.click(at.x, at.y)
  await page.waitForTimeout(300)
  await expect(overlay).toHaveAttribute('aria-busy', 'true')
  expect(await storeCall(page, 'return designer.getState().selected')).toBeNull()

  await hot.release()
  await expect(save).toHaveCount(0)
  // Selected without a second click: the press was hit-tested again on the rendered app.
  await expect(selection).toHaveAttribute('data-locator', (await title.getAttribute('data-ast-node'))!)
  await expectSameRect(selection, title)
  expect(ops).toHaveLength(1)
})

test('an app that animates without pause does not keep the canvas busy after an edit', async ({ page }) => {
  await openCanvas(page)
  const frame = (await (await page.locator('iframe[title="App canvas"]').elementHandle())!.contentFrame())!
  // A ticker in the app's document: its DOM changes every 16 ms, as with an animation library
  // or a clock, so it never goes quiet. It lives in this page only; no file is touched.
  await frame.evaluate(() => {
    const el = document.createElement('div')
    el.setAttribute('data-e2e-ticker', '')
    document.body.append(el)
    let n = 0
    setInterval(() => (el.style.width = `${n++ % 100}px`), 16)
  })
  await timeAnswers(page)
  const save = app(page).getByRole('button', { name: 'Save changes' })
  const cancel = app(page).getByRole('button', { name: 'Cancel' })
  const selection = page.locator('[data-canvas-box="selection"]')
  await page.mouse.click(center(await box(save)).x, center(await box(save)).y)
  await expect(selection).toHaveCount(1)

  const deleted = applied(page)
  await page.keyboard.press('Delete')
  await deleted
  await expect(save).toHaveCount(0) // HMR rendered; the ticker keeps going
  // Bounded from the edit's render (FrameSession BUSY_MS), and from the answer however slow
  // Vite's hot update is (MAX_WAIT_MS).
  expect(await busyFor(page, false)).toBeLessThan(1_000)
  expect(await busyFor(page, true)).toBeLessThan(2_000)

  await page.mouse.click(center(await box(cancel)).x, center(await box(cancel)).y)
  await expect(selection).toHaveAttribute('data-locator', (await cancel.getAttribute('data-ast-node'))!)
})

test('when the hot update renders before the edit answers, the canvas settles right after the answer', async ({ page }) => {
  await openCanvas(page)
  const save = app(page).getByRole('button', { name: 'Save changes' })
  await page.mouse.click(center(await box(save)).x, center(await box(save)).y)
  await expect(page.locator('[data-canvas-box="selection"]')).toHaveCount(1)
  await timeAnswers(page)
  await page.route('**/@trivia/api/apply', async (route) => {
    const response = await route.fetch() // the engine writes the file…
    await save.waitFor({ state: 'detached' }) // …Vite's hot update renders it…
    await page.waitForTimeout(250) // …and the app goes quiet, all before the designer hears back
    await route.fulfill({ response })
  })
  await page.keyboard.press('Delete')
  expect(await busyFor(page, true)).toBeLessThan(500)
  expect(dashboard()).not.toContain('Save changes')
})

test('dragging the Cancel button into CardContent moves it in source; selection follows', async ({ page }) => {
  await openCanvas(page)
  const ops = recordOps(page)
  const cancel = app(page).getByRole('button', { name: 'Cancel' })
  const fields = app(page).locator('[data-slot="card-content"] > div')
  const [cancelLoc, nameFieldLoc] = [await cancel.getAttribute('data-ast-node'), await fields.nth(0).getAttribute('data-ast-node')]
  const [cancelBox, nameField, publicRow] = [await box(cancel), await box(fields.nth(0)), await box(fields.nth(1))]

  // Press on Cancel, pass the 4px threshold, then hover the gap between the first two fields:
  // CardContent is under the cursor, its nearest child is the name field, cursor below its middle.
  const start = center(cancelBox)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + 6, start.y - 6, { steps: 2 })
  await expect(page.locator('[data-canvas-box="selection"]')).toHaveClass(/border-dashed/)

  // Over the page padding (App.tsx's <main>): another file, a drop like any other.
  const card = await box(app(page).locator('[data-slot="card"]'))
  await page.mouse.move(card.x + card.width / 2, card.y + card.height + 40, { steps: 4 })
  await expect(page.locator('[data-canvas-drop="inside"]')).toBeVisible()
  await expect(page.getByTestId('canvas-drop-label')).toHaveText('Inside main')
  // Over a .map() badge: it can't anchor before/after, so the drop goes inside its container.
  const pro = await box(app(page).getByText('Pro', { exact: true }))
  await page.mouse.move(pro.x + 4, pro.y + 4, { steps: 4 })
  await expect(page.locator('[data-canvas-drop="inside"]')).toBeVisible()
  await expect(page.getByTestId('canvas-drop-label')).toHaveText('Inside div')

  const gap = { x: nameField.x + nameField.width / 2, y: (nameField.y + nameField.height + publicRow.y) / 2 }
  await page.mouse.move(gap.x, gap.y, { steps: 8 })

  const line = page.locator('[data-canvas-drop="line-x"]')
  await expect(line).toBeVisible()
  await expect(page.getByTestId('canvas-drop-label')).toHaveText('After div')
  await expect(page.getByTestId('canvas-cursor-chip')).toHaveText(/^Button\s*After div$/)
  const lineBox = await box(line)
  expect(Math.abs(lineBox.y + lineBox.height / 2 - (nameField.y + nameField.height))).toBeLessThan(1.5)
  expect(Math.abs(lineBox.width - nameField.width)).toBeLessThan(1)

  await page.mouse.up()
  await expect(page.getByTestId('canvas-cursor-chip')).toHaveCount(0)
  await expect.poll(dashboard).not.toBe(original)
  // Both ends of the move carry the name the engine must still find there.
  expect(ops).toEqual([
    { op: 'move', source: cancelLoc, expectedName: 'Button', target: nameFieldLoc, expectedTargetName: 'div', placement: 'after' },
  ])
  const src = dashboard()
  const content = src.slice(src.indexOf('<CardContent'), src.indexOf('</CardContent>'))
  const footer = src.slice(src.indexOf('<CardFooter'), src.indexOf('</CardFooter>'))
  expect(content).toContain('<Button variant="ghost">Cancel</Button>')
  expect(footer).not.toContain('Cancel')
  // Placed right after the name field, before the "Public" row.
  expect(content.indexOf('Cancel')).toBeGreaterThan(content.indexOf('placeholder="my-app"'))
  expect(content.indexOf('Cancel')).toBeLessThan(content.indexOf('htmlFor="public"'))

  // HMR re-rendered the canvas: Cancel now lives in CardContent and stays selected.
  const moved = app(page).locator('[data-slot="card-content"] > button', { hasText: 'Cancel' })
  await expect(moved).toBeVisible()
  await expect(app(page).locator('[data-slot="card-footer"] button', { hasText: 'Cancel' })).toHaveCount(0)
  const selection = page.locator('[data-canvas-box="selection"]')
  await expect(selection).toHaveAttribute('data-locator', (await moved.getAttribute('data-ast-node'))!)
  await expectSameRect(selection, moved)
  await expect(selection).not.toHaveClass(/border-dashed/)
})

test('a palette drop inserts the template where the indicator shows', async ({ page }) => {
  await openCanvas(page)
  // The shell's palette starts the drag; the canvas only sees it arrive over the overlay. This
  // drag carries the template only in dataTransfer (no store.drag), the fallback path.
  const template = {
    component: 'Badge',
    label: 'Badge',
    snippet: '<Badge variant="outline">Draft</Badge>',
    imports: [{ name: 'Badge', source: '@/components/ui/badge' }],
  }
  const data = await page.evaluateHandle((json) => {
    const dt = new DataTransfer()
    dt.setData('application/x-trivia-template', json)
    return dt
  }, JSON.stringify(template))
  const overlay = page.getByTestId('canvas-overlay')
  const ops = recordOps(page)
  const cancelLoc = await app(page).getByRole('button', { name: 'Cancel' }).getAttribute('data-ast-node')
  const cancel = await box(app(page).getByRole('button', { name: 'Cancel' }))
  const at = { clientX: cancel.x + 6, clientY: cancel.y + cancel.height / 2 } // left half: before, on the row axis
  await overlay.dispatchEvent('dragenter', { dataTransfer: data, ...at })
  await overlay.dispatchEvent('dragover', { dataTransfer: data, ...at })
  await expect(page.locator('[data-canvas-drop="line-y"]')).toBeVisible()
  await expect(page.getByTestId('canvas-drop-label')).toHaveText('Before Button')

  await overlay.dispatchEvent('drop', { dataTransfer: data, ...at })
  await expect.poll(dashboard).toContain('<Badge variant="outline">Draft</Badge>')
  expect(ops).toEqual([
    { op: 'insert', target: cancelLoc, expectedName: 'Button', placement: 'before', snippet: template.snippet, imports: template.imports },
  ])
  const src = dashboard()
  const footer = src.slice(src.indexOf('<CardFooter'), src.indexOf('</CardFooter>'))
  expect(footer).toContain('<Badge variant="outline">Draft</Badge>\n          <Button variant="ghost">Cancel</Button>')
  expect(src.match(/import \{ Badge \}/g)).toHaveLength(1) // already imported: not duplicated

  const inserted = app(page).locator('[data-slot="card-footer"] [data-slot="badge"]', { hasText: 'Draft' })
  await expect(inserted).toBeVisible()
  await expect(page.locator('[data-canvas-drop]')).toHaveCount(0)
  const selection = page.locator('[data-canvas-box="selection"]')
  await expect(selection).toHaveAttribute('data-locator', (await inserted.getAttribute('data-ast-node'))!)
  await expectSameRect(selection, inserted)
})

test('wheel over the overlay scrolls the app; boxes stay on their element', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 320 })
  await openCanvas(page)
  const title = app(page).getByText('Project settings')
  await page.mouse.click(center(await box(title)).x, center(await box(title)).y)
  const selection = page.locator('[data-canvas-box="selection"]')
  await expectSameRect(selection, title)

  const overlay = await box(page.getByTestId('canvas-overlay'))
  await page.mouse.move(overlay.x + overlay.width / 2, overlay.y + overlay.height / 2)
  await page.mouse.wheel(0, 120)
  const frame = await (await page.locator('iframe[title="App canvas"]').elementHandle())!.contentFrame()
  const scrollY = () => frame!.evaluate(() => window.scrollY)
  await expect.poll(scrollY).toBeGreaterThan(0)
  await expectSameRect(selection, title)
})

test('zoom scales the app and the overlay math together', async ({ page }) => {
  await openCanvas(page)
  const save = app(page).getByRole('button', { name: 'Save changes' })
  const full = await box(save)
  await storeCall(page, `designer.getState().setZoom(0.5)`)
  await expect.poll(async () => (await box(save)).width).toBeCloseTo(full.width / 2, 0)

  const half = await box(save)
  await page.mouse.move(center(half).x, center(half).y)
  const hover = page.locator('[data-canvas-box="hover"]')
  await expectSameRect(hover, save)
  // Sizes are reported in the app's CSS pixels, whatever the zoom.
  await expect(page.getByTestId('canvas-hover-label')).toHaveText(`Button${Math.round(full.width)} × ${Math.round(full.height)}`)
  await page.mouse.click(center(half).x, center(half).y)
  await expectSameRect(page.locator('[data-canvas-box="selection"]'), save)

  // Pinch (ctrl + wheel) zooms in.
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -50)
  await page.keyboard.up('Control')
  await expect.poll(() => storeCall<number>(page, 'return designer.getState().zoom')).toBeGreaterThan(0.5)
  await expectSameRect(page.locator('[data-canvas-box="selection"]'), save)
})

test('interact mode passes the pointer to the app', async ({ page }) => {
  await openCanvas(page)
  await storeCall(page, `designer.getState().setMode('interact')`)
  await expect(page.getByTestId('canvas-overlay')).toHaveCSS('pointer-events', 'none')
  const input = app(page).getByPlaceholder('my-app')
  const inputBox = await box(input)
  await page.mouse.click(center(inputBox).x, center(inputBox).y)
  await page.keyboard.type('hello')
  await expect(input).toHaveValue('hello')
  await expect(page.locator('[data-canvas-box="hover"]')).toHaveCount(0)
  expect(dashboard()).toBe(original)
})

test('previews apply and clear without touching the source', async ({ page }) => {
  await openCanvas(page)
  const footer = app(page).locator('[data-slot="card-footer"]')
  const save = app(page).getByRole('button', { name: 'Save changes' })
  const footerLoc = (await footer.getAttribute('data-ast-node'))!
  const saveLoc = (await save.getAttribute('data-ast-node'))!
  const footerClass = (await footer.getAttribute('class'))!
  const saveClass = (await save.getAttribute('class'))!
  await page.mouse.click(center(await box(save)).x, center(await box(save)).y)
  const selection = page.locator('[data-canvas-box="selection"]')

  // className: drop the user's tokens that changed, add the new ones (twMerge resolves conflicts).
  await storeCall(page, `canvas.previewClassName(${JSON.stringify(footerLoc)}, 'justify-end gap-2', 'justify-start gap-2')`)
  await expect(footer).toHaveClass(/\bjustify-start\b/)
  await expect(footer).not.toHaveClass(/\bjustify-end\b/)
  await storeCall(page, `canvas.previewClassName(${JSON.stringify(saveLoc)}, '', 'px-6')`)
  await expect(save).toHaveClass(/\bpx-6\b/)
  await expect(save).not.toHaveClass(/\bpx-2\.5\b/)

  // style: real CSS through <style id="trivia-preview">; the selection box follows the new size.
  const before = await box(save)
  await storeCall(page, `canvas.previewStyle(${JSON.stringify(saveLoc)}, { 'padding-left': '40px', 'padding-right': '40px' })`)
  await expect.poll(async () => (await box(save)).width).toBeGreaterThan(before.width + 20)
  await expectSameRect(selection, save)
  await expect(app(page).locator('style#trivia-preview')).toHaveCount(1)
  expect(await storeCall(page, `return canvas.elements(${JSON.stringify(saveLoc)}).length`)).toBe(1)

  await storeCall(page, 'canvas.clearPreviews()')
  await expect(footer).toHaveAttribute('class', footerClass)
  await expect(save).toHaveAttribute('class', saveClass)
  await expect(app(page).locator('style#trivia-preview')).toHaveCount(0)
  await expect(app(page).locator('[data-trivia-preview-id]')).toHaveCount(0)
  await expectSameRect(selection, save)
  expect(dashboard()).toBe(original)
})

test('an edit made outside the designer bumps the revision and drops previews (HMR)', async ({ page }) => {
  await openCanvas(page)
  const save = app(page).getByRole('button', { name: 'Save changes' })
  const saveLoc = (await save.getAttribute('data-ast-node'))!
  await storeCall(page, `canvas.previewStyle(${JSON.stringify(saveLoc)}, { 'outline': '3px solid red' })`)
  await expect(app(page).locator('style#trivia-preview')).toHaveCount(1)
  const revision = await storeCall<number>(page, 'return designer.getState().revision')

  writeWhole(DASHBOARD, original.replace('Project settings', 'Project preferences'))
  await expect(app(page).getByText('Project preferences')).toBeVisible()
  await expect.poll(() => storeCall<number>(page, 'return designer.getState().revision')).toBeGreaterThan(revision)
  await expect(app(page).locator('style#trivia-preview')).toHaveCount(0)
  await expect(app(page).locator('[data-trivia-preview-id]')).toHaveCount(0)
})

test('the right-click menu moves an element down and deletes one, and both undo byte for byte', async ({ page }) => {
  await openCanvas(page)
  const cancel = app(page).getByRole('button', { name: 'Cancel' })
  const at = center(await box(cancel))
  await page.mouse.click(at.x, at.y, { button: 'right' })
  const menu = page.getByRole('menu', { name: 'Actions for Button' })
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Move up' })).toBeDisabled() // already first
  await menu.getByRole('menuitem', { name: 'Move down' }).click()
  await expect(menu).toBeHidden()
  await expect.poll(dashboard).toContain('<Button>Save changes</Button>\n          <Button variant="ghost">Cancel</Button>')
  await expect(app(page).getByRole('button', { name: 'Cancel' })).toBeVisible()

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await expect.poll(dashboard).toBe(original)

  // Delete through the menu, once the canvas shows the undo: until then a right-click opens
  // nothing (or its action is refused), as the canvas waits for its render.
  await expect(app(page).locator('[data-slot=card-footer] button').first()).toHaveText('Cancel')
  await expect(page.getByTestId('canvas-overlay')).not.toHaveAttribute('aria-busy')
  const save = center(await box(app(page).getByRole('button', { name: 'Save changes' })))
  await page.mouse.click(save.x, save.y, { button: 'right' })
  await page.getByRole('menu', { name: 'Actions for Button' }).getByRole('menuitem', { name: 'Delete' }).click()
  await expect.poll(dashboard).not.toContain('Save changes')
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await expect.poll(dashboard).toBe(original)
})

test('the Layers tab moves elements: a row dragged onto another, and Alt+↓; both undo byte for byte', async ({ page }) => {
  await openCanvas(page)
  await page.getByRole('tab', { name: 'Layers' }).click()
  const tree = page.getByRole('tree', { name: 'Layers' })
  const cancel = tree.getByRole('treeitem', { name: /^Button Cancel$/ })
  const save = tree.getByRole('treeitem', { name: /^Button Save changes$/ })
  await expect(cancel).toBeVisible()
  const ops = recordOps(page)

  // Save's row onto the top edge of Cancel's: before it, in the source.
  await save.dragTo(cancel, { targetPosition: { x: 40, y: 2 } })
  await expect.poll(dashboard).toContain('<Button>Save changes</Button>\n          <Button variant="ghost">Cancel</Button>')
  expect(ops.at(-1)).toMatchObject({ op: 'move', expectedName: 'Button', expectedTargetName: 'Button', placement: 'before' })
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await expect.poll(dashboard).toBe(original)

  // Alt+↓ on Cancel's row moves it past Save, and the row keeps the focus.
  await expect(page.getByTestId('canvas-overlay')).not.toHaveAttribute('aria-busy')
  await tree.getByRole('treeitem', { name: /^Button Cancel$/ }).click()
  await page.keyboard.press('Alt+ArrowDown')
  await expect.poll(dashboard).toContain('<Button>Save changes</Button>\n          <Button variant="ghost">Cancel</Button>')
  await expect(tree.getByRole('treeitem', { name: /^Button Cancel$/ })).toBeFocused()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await expect.poll(dashboard).toBe(original)
})

test('dragging Save out of the page into App.tsx moves it between files, and one undo restores both', async ({ page }) => {
  await openCanvas(page)
  const APP_FILE = fileURLToPath(new URL('../examples/playground/src/App.tsx', import.meta.url))
  const appBefore = fs.readFileSync(APP_FILE, 'utf8')
  try {
    const save = center(await box(app(page).getByRole('button', { name: 'Save changes' })))
    const card = await box(app(page).locator('[data-slot="card"]'))
    await page.mouse.move(save.x, save.y)
    await page.mouse.down()
    await page.mouse.move(save.x + 6, save.y + 6, { steps: 2 })
    await page.mouse.move(card.x + card.width / 2, card.y + card.height + 40, { steps: 6 })
    await expect(page.getByTestId('canvas-drop-label')).toHaveText('Inside main')
    await page.mouse.up()
    await expect.poll(() => fs.readFileSync(APP_FILE, 'utf8')).toContain('      <Button>Save changes</Button>\n    </main>')
    expect(fs.readFileSync(APP_FILE, 'utf8')).toContain('import { Button } from "@/components/ui/button"')
    expect(dashboard()).toBe(original.replace('          <Button>Save changes</Button>\n', ''))
    await expect(app(page).getByRole('button', { name: 'Save changes' })).toBeVisible() // rendered in its new place

    await expect(page.getByTestId('canvas-overlay')).not.toHaveAttribute('aria-busy')
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
    await expect.poll(dashboard).toBe(original)
    await expect.poll(() => fs.readFileSync(APP_FILE, 'utf8')).toBe(appBefore)
  } finally {
    restore(APP_FILE, appBefore)
  }
})

