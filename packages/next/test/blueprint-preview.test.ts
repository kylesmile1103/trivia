import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { EngineService, loadEngine } from '@trivia/dev-service'
import { expect, it } from 'vitest'

import { createNextHost } from '../src/host.js'
import { stampFile } from '../src/paths.js'

it('publishes split Next drafts and removes only the owned files on eject, delete and stop', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trivia-next-draft-')))
  const engine = await loadEngine()
  await fs.mkdir(path.join(root, 'app/(app)'), { recursive: true })
  await fs.writeFile(path.join(root, 'app/(app)/layout.tsx'), 'export default function Layout({ children }) { return children }\n')
  await fs.writeFile(path.join(root, 'app/providers.tsx'), 'export function Providers() { return <Refine resources={[]} /> }\n')
  await fs.mkdir(path.join(root, 'src/components/ui'), { recursive: true })
  await fs.copyFile(new URL('../../../examples/next-admin/src/components/ui/button.tsx', import.meta.url),
    path.join(root, 'src/components/ui/button.tsx'))
  const host = createNextHost(root, engine)
  const service = new EngineService({ host, engine, version: 'test' })
  const node = 'n_00000000000000000000000001'
  const previewRoot = path.join(root, 'app/(blueprint-preview)/%5F_blueprint')
  try {
    await fs.mkdir(path.join(root, 'blueprint/pages'), { recursive: true })
    await fs.writeFile(path.join(root, 'blueprint/app.blueprint.json'), JSON.stringify({
      $schema: 'https://trivia.dev/schemas/blueprint/app.v1.json',
      blueprintVersion: 1, name: 'DraftApp', targets: { web: 'next-refine' },
    }))
    for (const [index, name] of ['First', 'Second', 'Third'].entries()) {
      const doc = 'pages/' + name + '.page.json'
      await fs.writeFile(path.join(root, 'blueprint', doc), JSON.stringify({
        $schema: 'https://trivia.dev/schemas/blueprint/page.v1.json',
        blueprintVersion: 1, id: 'pg_' + String(index + 1).padStart(26, '0'),
        name, kind: 'custom', route: '/draft/' + name.toLowerCase(), root: node,
        nodes: { [node]: { type: 'Button', name: 'button', parent: null, slot: null, order: 'a0' } },
        props: { [node]: { children: 'Draft button' } },
        actions: { [node + '.onClick']: [{ do: 'toast', message: '"Saved"' }] },
      }))
      const result = await service.previewBlueprint(name).catch((error: { details?: unknown }) => {
        throw new Error(JSON.stringify(error.details), { cause: error })
      })
      const view = path.join(previewRoot, name, 'view.tsx')
      expect(result).toMatchObject({ route: '/__blueprint/' + name, module: 'app/(blueprint-preview)/%5F_blueprint/' + name + '/page.tsx' })
      expect(await fs.readFile(view, 'utf8')).toContain('data-bp-node')
      expect(stampFile(view, root)).toBeNull()
      expect((await service.routes()).some(({ path }) => path.startsWith('/__blueprint/'))).toBe(false)
      if (name === 'First') {
        await service.ejectBlueprint([name])
        expect(await fs.readFile(path.join(root, 'app/(app)/draft/first/view.tsx'), 'utf8')).not.toContain('data-bp-node')
        await expect(fs.stat(view)).rejects.toMatchObject({ code: 'ENOENT' })
      } else if (name === 'Second') {
        const baseRev = (await service.blueprint.read()).docs[doc]!.rev
        await service.patchBlueprint([{ op: 'deletePage', doc, baseRev }], 'Delete draft')
        await expect(fs.stat(view)).rejects.toMatchObject({ code: 'ENOENT' })
      }
    }
    await host.preview.close?.()
    await expect(fs.stat(path.dirname(previewRoot))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await host.preview.close?.()
    await fs.rm(root, { recursive: true, force: true })
  }
})
