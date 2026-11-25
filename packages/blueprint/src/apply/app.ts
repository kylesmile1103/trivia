// App ops: setApp, setNav (T017).
import { appSchema, type AppDoc } from '../types/app.js'
import { BLUEPRINT_VERSION, SCHEMA_URL } from '../types/common.js'
import type { OpOf } from '../types/ops.js'
import { editApp, refuse, type Draft } from './draft.js'

export function setApp(draft: Draft, op: OpOf<'setApp'>): void {
  const { doc, name, targets, auth, theme } = op
  const web = targets?.web
  let app: AppDoc
  if (draft.has(doc)) {
    app = editApp(draft, doc)
    if (name !== undefined) app.name = name
    if (web !== undefined) app.targets.web = web
  } else {
    if (name === undefined || web === undefined) {
      refuse('invalid_op', `Creating ${doc} requires name and targets.web`)
    }
    app = appSchema.parse({
      $schema: SCHEMA_URL.app,
      blueprintVersion: BLUEPRINT_VERSION,
      name,
      targets: { web },
    })
    draft.put(doc, app)
  }

  const api = targets?.api
  if (api === null) delete app.targets.api
  else if (api !== undefined) app.targets.api = api
  if (auth !== undefined) app.auth = auth
  if (theme !== undefined) {
    for (const [key, value] of Object.entries(theme.tokens)) {
      if (value === null) delete app.theme.tokens[key]
      else app.theme.tokens[key] = value
    }
  }
}

export function setNav(draft: Draft, op: OpOf<'setNav'>): void {
  const app = editApp(draft, op.doc)
  app.nav = op.nav
}
