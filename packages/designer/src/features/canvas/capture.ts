// The canvas as a PNG, for trivia_screenshot (docs/mcp.md). html-to-image turns the page into
// an SVG; we rasterize that SVG ourselves because its toPng waits for requestAnimationFrame,
// which browsers pause while the designer is a background tab or a covered window, the usual
// state while the user talks to their agent. Its clone step still waits for a frame on
// <canvas> and <video> elements, so a capture also has a deadline that says why it failed.

export interface Capture {
  /** data:image/png;base64,… */
  png: string
  width: number
  height: number
}

export interface CaptureOptions {
  maxHeight: number
  timeoutMs: number
}

/** Render `doc` (the canvas iframe's document) at its width and up to `maxHeight` of its height. */
export async function captureDocument(doc: Document, { maxHeight, timeoutMs }: CaptureOptions): Promise<Capture> {
  const view = doc.defaultView
  if (!view) throw new Error('the canvas has no page loaded')
  const root = doc.documentElement
  const width = root.clientWidth
  const height = Math.min(root.scrollHeight, maxHeight)
  const background = view.getComputedStyle(doc.body).backgroundColor
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(stalled(document))), timeoutMs)
  })
  try {
    return await Promise.race([render(root, width, height, background), deadline])
  } finally {
    clearTimeout(timer)
  }
}

async function render(root: HTMLElement, width: number, height: number, background: string): Promise<Capture> {
  const { toSvg } = await import('html-to-image')
  const svg = await toSvg(root, { width, height, ...(background ? { backgroundColor: background } : {}) })
  const image = await load(svg)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('this browser has no 2D canvas to draw the screenshot on')
  if (background) {
    context.fillStyle = background
    context.fillRect(0, 0, width, height)
  }
  context.drawImage(image, 0, 0, width, height)
  return { png: canvas.toDataURL('image/png'), width, height }
}

/** An image's load event, unlike a frame, comes in a background tab too. */
function load(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('the browser could not render the page as an image'))
    image.src = src
  })
}

function stalled(designer: Document): string {
  return designer.visibilityState === 'hidden'
    ? 'the designer is in the background, so the browser paused the rendering the screenshot waits for (the page ' +
        'has a <canvas> or <video>); ask the user to bring the designer to the front and try again'
    : 'rendering the page took too long'
}
