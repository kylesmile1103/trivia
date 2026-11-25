import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import type { NextConfig } from 'next'
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD } from 'next/constants.js'

import { APP_DIRECTORIES, PREVIEW_GROUP, stampFile } from './paths.js'

type ConfigContext = { defaultConfig: NextConfig }
type ConfigFactory = (phase: string, context: ConfigContext) => NextConfig | Promise<NextConfig>
type TurboRules = NonNullable<NonNullable<NextConfig['turbopack']>['rules']>

const resolve = createRequire(import.meta.url).resolve

export function withTrivia(config: NextConfig | ConfigFactory = {}, options: { root?: string } = {}): ConfigFactory {
  return async (phase, context) => {
    const input = typeof config === 'function' ? await config(phase, context) : config
    if (phase !== PHASE_DEVELOPMENT_SERVER && phase !== PHASE_PRODUCTION_BUILD) return input
    const root = fs.realpathSync(options.root ?? process.cwd())
    if (phase === PHASE_PRODUCTION_BUILD) {
      const preview = APP_DIRECTORIES.map((dir) => path.join(root, dir, PREVIEW_GROUP)).find((dir) => fs.existsSync(dir))
      if (preview) throw new Error(`[trivia] Delete ${preview} before building for production.`)
      return input
    }

    const loader = { loader: resolve('@trivia/next/loader'), options: { root } }
    const rules: TurboRules = { ...input.turbopack?.rules }
    for (const pattern of ['*.tsx', '*.jsx']) {
      const configured = rules[pattern]
      const entries = configured === undefined ? [] : Array.isArray(configured) ? configured : [configured]
      rules[pattern] = [...entries, {
        condition: { not: { any: ['foreign', { path: /(?:^|\/)app\/\(blueprint-preview\)\// }] } },
        loaders: [loader],
      }]
    }

    return {
      ...input,
      turbopack: { ...input.turbopack, rules },
      webpack(base, context) {
        const configured = input.webpack ? input.webpack(base, context) : base
        if (context.dev) {
          configured.module.rules.unshift({
            test: /\.[jt]sx$/,
            include: (file: string) => stampFile(file, root) !== null,
            enforce: 'pre',
            use: [loader],
          })
        }
        return configured
      },
    }
  }
}
