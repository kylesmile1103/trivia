import { z } from 'zod'

import { appSchema } from './types/app.js'
import { SCHEMA_URL } from './types/common.js'
import { pageSchema } from './types/page.js'

export function jsonSchemas(): { app: object; page: object } {
  // Blueprint files can omit fields that Zod fills in on load.
  const options = { target: 'draft-2020-12', io: 'input' } as const
  return {
    app: {
      $id: SCHEMA_URL.app,
      title: 'Trivia Blueprint App',
      description: 'Application settings and navigation for a Trivia blueprint.',
      ...z.toJSONSchema(appSchema, options),
    },
    page: {
      $id: SCHEMA_URL.page,
      title: 'Trivia Blueprint Page',
      description: 'A custom or contract page in a Trivia blueprint.',
      ...z.toJSONSchema(pageSchema, options),
    },
  }
}
