import { mkdir, writeFile } from 'node:fs/promises'

import { jsonSchemas } from '../dist/schemas.js'

const directory = new URL('../schemas/', import.meta.url)
await mkdir(directory, { recursive: true })
for (const [kind, schema] of Object.entries(jsonSchemas())) {
  const file = new URL(`${kind}.v1.json`, directory)
  await writeFile(file, JSON.stringify(schema, null, 2) + '\n')
}
