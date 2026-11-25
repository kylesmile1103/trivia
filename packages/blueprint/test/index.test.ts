import { describe, expect, it } from 'vitest'

import { packageName } from '../src/index.js'

describe('@trivia/blueprint', () => {
  it('builds and runs its tests', () => {
    expect(packageName).toBe('@trivia/blueprint')
  })
})
