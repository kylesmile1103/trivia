import { expect, it } from 'vitest'

import { intrinsicManifests } from './intrinsics.js'

it('FR-MF-06: curates the supported HTML tags and their element-specific props', () => {
  expect(intrinsicManifests.map(({ type }) => type)).toEqual([
    'div', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'section', 'header', 'footer', 'main', 'ul', 'li', 'a', 'img', 'form', 'label',
  ])
  const byTag = new Map(intrinsicManifests.map((manifest) => [manifest.type, manifest]))
  const props = (tag: string) => byTag.get(tag)?.props.map(({ name }) => name)

  expect(props('a')).toEqual(expect.arrayContaining(['className', 'id', 'href', 'target']))
  expect(props('img')).toEqual(expect.arrayContaining(['src', 'alt', 'width', 'height']))
  expect(props('label')).toContain('htmlFor')
  expect(props('div')).not.toContain('href')
  expect(byTag.get('img')?.slots).toEqual([])
  expect(byTag.get('div')?.slots).toEqual([{ name: 'children', kind: 'nodes' }])
  expect(props('div')).toContain('children')
  expect(byTag.get('form')?.events).toContainEqual({ name: 'onSubmit', prop: 'onSubmit' })
  expect(byTag.get('form')?.client).toBe(false)
})
