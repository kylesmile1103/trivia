import { describe, expect, it } from 'vitest'

import { ZOOM_MAX, ZOOM_MIN, clampZoom, formatZoom, stepZoom } from './zoom'

describe('zoom', () => {
  it('steps through the stops and snaps off-stop values', () => {
    expect(stepZoom(1, 1)).toBe(1.25)
    expect(stepZoom(1, -1)).toBe(0.75)
    expect(stepZoom(0.8, 1)).toBe(1)
    expect(stepZoom(0.8, -1)).toBe(0.75)
    expect(stepZoom(0.7499999, 1)).toBe(1)
  })

  it('stays within 25–200%', () => {
    expect(stepZoom(ZOOM_MAX, 1)).toBe(ZOOM_MAX)
    expect(stepZoom(ZOOM_MIN, -1)).toBe(ZOOM_MIN)
    expect(clampZoom(5)).toBe(ZOOM_MAX)
    expect(clampZoom(0.01)).toBe(ZOOM_MIN)
    expect(clampZoom(Number.NaN)).toBe(1)
    expect(formatZoom(0.25)).toBe('25%')
  })
})
