import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { project } from './project.js'
import { pageSchema } from './types/page.js'

const root = 'n_01JDK3M8A00000000000000001'
const first = 'n_01JDK3M8A00000000000000002'
const second = 'n_01JDK3M8A00000000000000003'
const third = 'n_01JDK3M8A00000000000000004'
const fourth = 'n_01JDK3M8A00000000000000005'

const header = '// Example (custom) /example'
const customPage = {
  $schema: 'https://trivia.dev/schemas/blueprint/page.v1.json',
  blueprintVersion: 1,
  id: 'pg_01JDK3M7Q2X8Y4Z6A1B3C5D7E9',
  name: 'Example',
  route: '/example',
  kind: 'custom',
  root,
  nodes: { [root]: { type: 'Card', name: 'card', parent: null, slot: null, order: 'a0' } },
}

function readFixture(name: string) {
  const file = new URL(`../fixtures/valid/backoffice/pages/${name}.page.json`, import.meta.url)
  return pageSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
}

describe('project', () => {
  it.each(['CustomerOverview', 'CustomerList'])('projects the %s fixture', async (name) => {
    await expect(project(readFixture(name))).toMatchFileSnapshot(`./__snapshots__/project/${name}.tsx.txt`)
  })

  it('renders children first and sorts named slots and siblings bytewise', () => {
    const page = pageSchema.parse({
      ...customPage,
      nodes: {
        ...customPage.nodes,
        [fourth]: { type: 'Input', name: 'email', parent: root, slot: 'actions', order: 'a0' },
        [third]: { type: 'Button', name: 'cancel', parent: root, slot: 'footer', order: 'aA' },
        [second]: { type: 'Button', name: 'remove', parent: root, slot: 'footer', order: 'aa' },
        [first]: { type: 'Button', name: 'save', parent: root, slot: 'footer', order: 'aA' },
        n_01JDK3M8A00000000000000006: { type: 'p', name: 'body', parent: root, slot: 'children', order: 'a0' },
      },
    })
    expect(project(page)).toBe([
      header,
      '<Card name="card">',
      '  <p name="body" />',
      '  <slot:actions>',
      '    <Input name="email" />',
      '  </slot:actions>',
      '  <slot:footer>',
      '    <Button name="save" />',
      '    <Button name="cancel" />',
      '    <Button name="remove" />',
      '  </slot:footer>',
      '</Card>',
      '',
    ].join('\n'))
  })

  it('filters and maps a node with both when and each', () => {
    const page = pageSchema.parse({
      ...customPage,
      control: { [root]: { when: 'row.visible', each: 'data.rows', as: 'row', key: 'row.id' } },
      styles: { [root]: { className: 'p-4' } },
      bindings: { [root]: { children: 'row.title' } },
    })
    expect(project(page)).toBe([
      header,
      '{data.rows.filter((row) => row.visible).map((row) => (',
      '  <Card name="card" key={row.id} className="p-4">{row.title}</Card>',
      '))}',
      '',
    ].join('\n'))
  })

  it('sorts merged props and quotes strings that need JSON escapes', () => {
    const page = pageSchema.parse({
      ...customPage,
      props: { [root]: { title: 'Line "one"\nC:\\temp', settings: { z: 1, a: false }, A: 'plain' } },
      bindings: { [root]: { active: 'state.active' } },
    })
    const element = String.raw`<Card name="card" A="plain" active={state.active} settings={{"z":1,"a":false}} title={"Line \"one\"\nC:\\temp"} />`
    expect(project(page)).toBe(`${header}\n${element}\n`)
  })

  it('self-closes an element with no content', () => {
    const page = pageSchema.parse(customPage)
    expect(project(page)).toBe(`${header}\n<Card name="card" />\n`)
  })

  it('reports an unreachable parent cycle and dangling references by ID', () => {
    const page = pageSchema.parse({
      ...customPage,
      nodes: {
        ...customPage.nodes,
        [third]: { type: 'Input', name: 'orphan', parent: fourth, slot: 'children', order: 'a0' },
        [second]: { type: 'div', name: 'alpha', parent: first, slot: 'children', order: 'a0' },
        [first]: { type: 'div', name: 'zeta', parent: second, slot: 'children', order: 'a0' },
      },
      actions: { [`${fourth}.onClick`]: [{ do: 'mutate', resource: 'Customer', operation: 'delete' }] },
    })
    expect(project(page)).toBe([
      header,
      '<Card name="card" />',
      '',
      '/*',
      'actions:',
      `  ${fourth}.onClick:`,
      '    mutate Customer.delete()',
      'unattached:',
      '  zeta (div)',
      '  alpha (div)',
      '  orphan (Input)',
      '*/',
      '',
    ].join('\n'))
  })

  it('visits the root only once when it has a cyclic parent reference', () => {
    const page = pageSchema.parse({
      ...customPage,
      nodes: {
        [root]: { type: 'Card', name: 'card', parent: first, slot: 'footer', order: 'a0' },
        [first]: { type: 'Input', name: 'email', parent: root, slot: 'children', order: 'a0' },
      },
    })
    expect(project(page)).toBe(`${header}\n<Card name="card">\n  <Input name="email" />\n</Card>\n`)
  })

  it('projects the same page identically on repeated calls', () => {
    const page = readFixture('CustomerOverview')
    const before = JSON.stringify(page)
    const firstProjection = project(page)
    expect(project(page)).toBe(firstProjection)
    expect(firstProjection.endsWith('*/\n')).toBe(true)
    expect(JSON.stringify(page)).toBe(before)
  })
})
