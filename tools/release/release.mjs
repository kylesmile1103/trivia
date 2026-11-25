// `pnpm release <version | major | minor | patch> [--dry-run] [nx release flags]`
//
// Versions every project in nx.json's "release" together, writes CHANGELOG.md, commits
// `release: v<version>`, tags, pushes, and creates the GitHub release from the changelog.
// Then it builds the desktop app and attaches its .dmg to that release (./desktop.mjs; macOS).
// It never publishes to npm (nothing is published yet). Before Nx runs, it checks:
// - a clean `main` (so the release commit holds only the release);
// - that every commit type since the last release tag is one Nx knows;
// - for a real run, a GitHub token and the scripted BankAdmin MVP acceptance check.
// Use this (or `nx release`), not `nx release version`/`changelog`: those subcommands refuse
// nx.json's "release.git", which holds the commit and tag messages.
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { attachDesktopApp } from './desktop.mjs'
import { githubToken } from './github.mjs'
import { checkMvpBeforeRelease, unknownCommitTypes } from './preflight.mjs'

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
if (!dryRun) {
  const token = githubToken(root)
  if (!token) fail('no GitHub token. Set GH_TOKEN, or let git sign in to github.com once (its credential helper keeps the token).')
  env.GH_TOKEN = token
}
if (!dryRun && process.platform !== 'darwin') {
  fail('the desktop app is bundled on macOS only; release from a Mac.')
}

if (dryRun) {
  console.log('release: a real release runs the BankAdmin MVP acceptance slice before tagging.')
} else {
  try {
    checkMvpBeforeRelease(root, process.env)
  } catch (error) {
    fail(error.message)
  }
}

const nx = spawnSync(path.join(root, 'node_modules', '.bin', 'nx'), ['release', ...args, '--skip-publish'], {
  cwd: root,
  env,
  stdio: 'inherit',
})
if (nx.status !== 0) process.exit(nx.status ?? 1)

if (dryRun) {
  console.log('\nrelease: then it would build the desktop app (nx run shell:bundle) and attach its .dmg.')
  process.exit(0)
}
const tag = git('describe', '--tags', '--exact-match', 'HEAD')
try {
  await attachDesktopApp(root, tag)
} catch (error) {
  fail(`${tag} is released, but the desktop app is not attached: ${error.message}\nFix that, then run: pnpm release:desktop ${tag}`)
}
