// `pnpm release <version | major | minor | patch> [--dry-run] [nx release flags]`
//
// Versions every project in nx.json's "release" together, writes CHANGELOG.md, commits
// `release: v<version>`, tags, pushes, and creates the GitHub release from the changelog.
// It never publishes to npm (nothing is published yet). Before Nx runs, it checks:
// - a clean `main` (so the release commit holds only the release);
// - that every commit type since the last release tag is one Nx knows;
// - for a real run, a GitHub token: GH_TOKEN, GITHUB_TOKEN, or git's credential helper.
// Use this (or `nx release`), not `nx release version`/`changelog`: those subcommands refuse
// nx.json's "release.git", which holds the commit and tag messages.
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { unknownCommitTypes } from './preflight.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run') || args.includes('-d')

const git = (...gitArgs) => execFileSync('git', gitArgs, { cwd: root, encoding: 'utf8' }).trim()
const fail = (message) => {
  console.error(`release: ${message}`)
  process.exit(1)
}

if (!dryRun) {
  if (git('status', '--porcelain')) fail('the working tree has changes; commit or stash them first.')
  if (git('branch', '--show-current') !== 'main') fail('releases are cut from main.')
}

const require = createRequire(import.meta.url)
const defaults = require('nx/src/command-line/release/config/conventional-commits.js').DEFAULT_CONVENTIONAL_COMMITS_CONFIG
const declared = JSON.parse(fs.readFileSync(path.join(root, 'nx.json'), 'utf8')).release?.conventionalCommits?.types ?? {}
const known = new Set([...Object.keys(defaults.types), ...Object.keys(declared)])

let lastTag
try {
  lastTag = git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', '--exclude', '*-*')
} catch {
  fail('there is no release tag (v<major>.<minor>.<patch>) to start from.')
}
const subjects = git('log', `${lastTag}..HEAD`, '--format=%s').split('\n').filter(Boolean)
const unknown = unknownCommitTypes(subjects, known)
if (unknown.size > 0) {
  const lines = [...unknown].flatMap(([type, list]) => [`  ${type}:`, ...list.map((s) => `    ${s}`)])
  fail(
    `Nx would leave these commits out of the changelog: their prefix is not a known type.\n${lines.join('\n')}\n` +
      'Add each prefix to "release.conventionalCommits.types" in nx.json, with the title of its section.',
  )
}

const env = { ...process.env }
if (!dryRun && !env.GH_TOKEN && !env.GITHUB_TOKEN) {
  const credential = spawnSync('git', ['credential', 'fill'], {
    cwd: root,
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
    env: { ...env, GIT_TERMINAL_PROMPT: '0' },
  })
  const token = /^password=(.+)$/m.exec(credential.stdout ?? '')?.[1]
  if (!token) fail('no GitHub token. Set GH_TOKEN, or let git sign in to github.com once (its credential helper keeps the token).')
  env.GH_TOKEN = token
}

const nx = spawnSync(path.join(root, 'node_modules', '.bin', 'nx'), ['release', ...args, '--skip-publish'], {
  cwd: root,
  env,
  stdio: 'inherit',
})
process.exit(nx.status ?? 1)
