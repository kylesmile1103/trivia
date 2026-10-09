'use strict'
// `nx g @trivia/tools:package <name>`: a new TypeScript library in packages/<name>, set up like
// packages/contract-sync (strict tsconfig, vitest, build/typecheck/test scripts, a short Nx
// name), and added to nx.json's release group so it is versioned with everything else.
// Plain CommonJS for the same reason as tools/release/version-actions.cjs.
const path = require('node:path')
const { generateFiles, getProjects, installPackagesTask, readJson } = require('@nx/devkit')

/** The library whose TypeScript, vitest and @types/node versions a new package takes. */
const MODEL_PACKAGE = 'packages/contract-sync/package.json'
const NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

/** The version every released project is at: they are versioned together. */
function releaseVersion(tree) {
  const projects = getProjects(tree)
  for (const name of readJson(tree, 'nx.json').release?.projects ?? []) {
    const root = projects.get(name)?.root
    const manifest = root === undefined ? null : path.posix.join(root, 'package.json')
    if (manifest && tree.exists(manifest)) return readJson(tree, manifest).version
  }
  throw new Error('No project in nx.json "release.projects" has a package.json, so the current version is unknown')
}

function toolingVersions(tree) {
  if (!tree.exists(MODEL_PACKAGE)) {
    throw new Error(`${MODEL_PACKAGE} is missing: a new package takes its TypeScript, vitest and @types/node versions from it`)
  }
  const dev = readJson(tree, MODEL_PACKAGE).devDependencies ?? {}
  const versions = { typescript: dev.typescript, vitest: dev.vitest, typesNode: dev['@types/node'] }
  for (const [tool, version] of Object.entries(versions)) {
    if (!version) throw new Error(`${MODEL_PACKAGE} has no devDependency for ${tool}`)
  }
  return versions
}

/**
 * Adds a project to nx.json's "release.projects" in place: devkit's updateJson would re-serialize
 * the whole file. The result is parsed back and checked before it is returned.
 */
function addReleaseProject(text, name) {
  const before = JSON.parse(text).release?.projects
  if (!Array.isArray(before)) throw new Error('nx.json has no "release.projects" array')
  const release = text.search(/"release"\s*:/)
  const open = text.slice(release).search(/"projects"\s*:\s*\[/)
  const start = text.indexOf('[', release + open)
  const end = text.indexOf(']', start)
  const items = text.slice(start + 1, end)
  const last = /"[^"]*"(?=\s*$)/.exec(items)
  let updated
  if (!last) {
    updated = `${text.slice(0, start + 1)}"${name}"${text.slice(end)}`
  } else {
    // One per line stays one per line; inline stays inline.
    const indent = /\n([ \t]*)"[^"]*"\s*$/.exec(items)
    const separator = indent ? `,\n${indent[1]}` : ', '
    const at = start + 1 + last.index + last[0].length
    updated = `${text.slice(0, at)}${separator}"${name}"${text.slice(at)}`
  }
  const after = JSON.parse(updated).release?.projects
  if (JSON.stringify(after) !== JSON.stringify([...before, name])) {
    throw new Error('Could not add the project to nx.json "release.projects" in place; add it by hand')
  }
  return updated
}

module.exports = async function packageGenerator(tree, options) {
  const { name, description = '' } = options
  if (!NAME.test(name)) throw new Error(`"${name}" is not a kebab-case name`)
  const root = `packages/${name}`
  if (tree.exists(root)) throw new Error(`${root} already exists`)
  if (getProjects(tree).has(name)) throw new Error(`There is already a project named "${name}"`)

  generateFiles(tree, path.join(__dirname, 'files'), root, {
    tmpl: '',
    name,
    description,
    version: releaseVersion(tree),
    versions: toolingVersions(tree),
  })
  tree.write('nx.json', addReleaseProject(tree.read('nx.json', 'utf-8'), name))
  // Link the new package into the workspace (pnpm install).
  return () => installPackagesTask(tree, true)
}

module.exports.addReleaseProject = addReleaseProject
