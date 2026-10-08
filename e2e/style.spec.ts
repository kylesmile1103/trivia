// Style panel end to end, through the StylePanel harness
// (packages/designer/src/features/inspector/style/harness): real playground, real engine, real HMR.
//
//   TRIVIA_APP_PORT=5341 TRIVIA_PORT=4441 pnpm exec playwright test e2e/style.spec.ts

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { expect, type FrameLocator, type Page, test } from '@playwright/test'

const DASHBOARD = fileURLToPath(new URL('../examples/playground/src/pages/Dashboard.tsx', import.meta.url))
// <div className="grid gap-2"> — the "Project name" field wrapper.
const LOCATOR = 'src/pages/Dashboard.tsx#Dashboard#0.0.1.0'
const TAG = '<div className="grid gap-2">'

let original: string
let errors: string[]

test.beforeEach(async ({ page }) => {
  original = await readFile(DASHBOARD, 'utf8')
  expect(original.split(TAG).length - 1, 'fixture: the target tag occurs exactly once').toBe(1)
  errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })
})

test.afterEach(async () => {
  try {
    expect(errors, 'no page errors (designer or canvas)').toEqual([])
  } finally {
    if ((await readFile(DASHBOARD, 'utf8')) !== original) await writeFile(DASHBOARD, original)
  }
})

/** Open the harness on LOCATOR and count the engine writes the page makes. */
async function open(page: Page) {
  const writes: string[] = []
  page.on('request', (req) => {
    if (req.method() === 'POST' && /\/@trivia\/api\/(apply|batch)$/.test(new URL(req.url()).pathname)) {
      writes.push(req.postData() ?? '')
    }
  })
  await page.goto(`/__trivia/src/features/inspector/style/harness/index.html?locator=${encodeURIComponent(LOCATOR)}`)
  const frame = page.frameLocator('iframe[title="Canvas"]')
  const target = frame.locator(`[data-ast-node="${LOCATOR}"]`)
  await expect(target).toHaveAttribute('class', 'grid gap-2')
  await expect(page.getByTestId('style-classname')).toHaveText('grid gap-2')
  return { frame, target, writes }
}

const paddingTop = (target: ReturnType<FrameLocator['locator']>) => target.evaluate((el) => getComputedStyle(el).paddingTop)
const previewCss = (frame: FrameLocator) =>
  frame.locator('html').evaluate((html) => html.ownerDocument.getElementById('trivia-style-preview')?.textContent ?? '')

test('scrubbing padding previews real CSS without writing; release writes one Tailwind class and HMR shows it', async ({ page }) => {
  const { frame, target, writes } = await open(page)
  expect(await paddingTop(target)).toBe('0px')

  // Drag the padding slider (0–96px) to a quarter of its track: 24px.
  const thumb = page.getByRole('slider', { name: 'Padding' })
  const track = page.locator('[data-slot="slider"]').filter({ has: thumb })
  const box = (await track.boundingBox())!
  const start = (await thumb.boundingBox())!
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2, { steps: 8 })

  // Mid-gesture: the canvas previews real CSS, the source and the DOM classes are untouched.
  await expect.poll(() => paddingTop(target)).toBe('24px')
  expect(await previewCss(frame)).toContain('padding: 1.5rem !important')
  await expect(page.getByRole('textbox', { name: 'Padding' })).toHaveValue('24')
  await expect(target).toHaveAttribute('class', 'grid gap-2')
  expect(await readFile(DASHBOARD, 'utf8')).toBe(original)
  expect(writes).toHaveLength(0)

  // Sample the element's padding every frame across release → write → HMR: the preview must
  // hold until the committed class renders, so it never flashes back to 0.
  await target.evaluate((el) => {
    const w = el.ownerDocument.defaultView as Window & { __samples?: string[] }
    w.__samples = []
    const tick = () => {
      w.__samples!.push(getComputedStyle(el.isConnected ? el : el.ownerDocument.querySelector(`[data-ast-node="${el.getAttribute('data-ast-node')}"]`)!).paddingTop)
      if (w.__samples!.length < 600) w.requestAnimationFrame(tick)
    }
    w.requestAnimationFrame(tick)
  })
  await page.mouse.up()

  // Release: exactly one write — a className change to a Tailwind class, nothing else.
  await expect.poll(async () => readFile(DASHBOARD, 'utf8')).not.toBe(original)
  const after = await readFile(DASHBOARD, 'utf8')
  expect(after).toBe(original.replace(TAG, '<div className="grid gap-2 p-6">'))
  expect(after).not.toContain('style=')
  expect(writes, writes.join('\n')).toHaveLength(1)
  expect(JSON.parse(writes[0]!)).toMatchObject({
    op: { op: 'updateProp', target: LOCATOR, prop: 'className', value: 'grid gap-2 p-6' },
  })

  // HMR: the class is in the DOM and the preview is gone, so the 24px now comes from Tailwind.
  await expect(target).toHaveAttribute('class', 'grid gap-2 p-6')
  await expect.poll(() => previewCss(frame)).toBe('')
  await expect.poll(() => paddingTop(target)).toBe('24px')
  const samples = await target.evaluate((el) => (el.ownerDocument.defaultView as Window & { __samples?: string[] }).__samples ?? [])
  expect(samples.length).toBeGreaterThan(0)
  expect(new Set(samples)).toEqual(new Set(['24px']))
  await expect(page.getByTestId('style-classname')).toHaveText('grid gap-2 p-6')
  await expect(page.getByRole('textbox', { name: 'Padding' })).toHaveValue('24')
  expect(writes).toHaveLength(1)
})

test('scrubbing the field handle (Figma-style) previews per step and commits once on release', async ({ page }) => {
  const { frame, target, writes } = await open(page)
  const field = page.getByRole('textbox', { name: 'Padding' })
  const handle = field.locator('xpath=preceding-sibling::span[1]')
  const box = (await handle.boundingBox())!
  const y = box.y + box.height / 2
  await page.mouse.move(box.x + box.width / 2, y)
  await page.mouse.down()
  // 4 screen px per step of 4px: 32px of travel → 8 steps → 32px (p-8).
  await page.mouse.move(box.x + box.width / 2 + 32, y, { steps: 8 })
  await expect.poll(() => paddingTop(target)).toBe('32px')
  await expect(field).toHaveValue('32')
  expect(await previewCss(frame)).toContain('padding: 2rem !important')
  expect(writes).toHaveLength(0)

  await page.mouse.up()
  await expect(target).toHaveAttribute('class', 'grid gap-2 p-8')
  expect(await readFile(DASHBOARD, 'utf8')).toBe(original.replace(TAG, '<div className="grid gap-2 p-8">'))
  await expect.poll(() => previewCss(frame)).toBe('')
  await expect.poll(() => paddingTop(target)).toBe('32px')
  expect(writes).toHaveLength(1)
})

test('arrow keys on the slider preview each step and write once per burst', async ({ page }) => {
  const { target, writes } = await open(page)
  const thumb = page.getByRole('slider', { name: 'Padding' })
  await thumb.focus()
  // One burst, timed in the page (20ms apart, like key repeat) so test-runner round trips on a
  // loaded machine cannot stretch it past the 450ms settle window — separate bursts are meant
  // to write separately.
  await thumb.evaluate(async (el) => {
    for (let i = 0; i < 3; i++) {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  })
  await expect.poll(() => paddingTop(target)).toBe('12px')
  expect(writes).toHaveLength(0) // previewed, not yet written
  await expect(target).toHaveAttribute('class', 'grid gap-2 p-3')
  expect(await readFile(DASHBOARD, 'utf8')).toBe(original.replace(TAG, '<div className="grid gap-2 p-3">'))
  expect(writes, writes.join('\n')).toHaveLength(1)
})

test('typed values: Escape cancels the preview without writing; Enter writes an arbitrary value', async ({ page }) => {
  const { target, writes } = await open(page)
  const field = page.getByRole('textbox', { name: 'Padding' })

  await field.fill('13')
  await expect.poll(() => paddingTop(target)).toBe('13px')
  await field.press('Escape')
  await expect.poll(() => paddingTop(target)).toBe('0px')
  expect(writes).toHaveLength(0)
  expect(await readFile(DASHBOARD, 'utf8')).toBe(original)

  await field.fill('13')
  await field.press('Enter')
  await expect(target).toHaveAttribute('class', 'grid gap-2 p-[13px]')
  await expect.poll(() => paddingTop(target)).toBe('13px')
  expect(await readFile(DASHBOARD, 'utf8')).toBe(original.replace(TAG, '<div className="grid gap-2 p-[13px]">'))
  expect(writes).toHaveLength(1)
})

test('discrete toggles commit immediately and replace the conflicting class in place', async ({ page }) => {
  const { target, writes } = await open(page)

  await page.getByRole('radio', { name: 'Flex (flex)' }).click()
  await expect(target).toHaveAttribute('class', 'flex gap-2')
  expect(await readFile(DASHBOARD, 'utf8')).toBe(original.replace(TAG, '<div className="flex gap-2">'))
  expect(writes).toHaveLength(1)

  // Flex-only controls appear once the element is a flex container.
  await page.getByRole('radio', { name: 'Column (flex-col)' }).click()
  await expect(target).toHaveAttribute('class', 'flex gap-2 flex-col')
  await expect.poll(() => target.evaluate((el) => getComputedStyle(el).flexDirection)).toBe('column')
  expect(writes).toHaveLength(2)
})
