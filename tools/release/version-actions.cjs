'use strict'
// Nx release version actions for every project in the release group. A project's manifest is
// its package.json, its Cargo.toml, or both (crates/trivia_napi is an npm package and a crate);
// a tauri.conf.json next to a Cargo.toml carries the app version too.
//
// Versions are edited in place, one value each. Files are never re-serialized, so every other
// byte stays where it was. Plain CommonJS: Nx loads .ts here only through swc/ts-node on Node
// 22.16 (no native type stripping), and this keeps the repo free of both.
const fs = require('node:fs')
const path = require('node:path')
const {
  default: JsVersionActions,
  afterAllProjectsVersioned: afterJsProjectsVersioned,
} = require('@nx/js/src/release/version-actions')

const CARGO_VERSION = /^(version\s*=\s*")([^"]*)(")/m

/** The [package] table of a Cargo.toml: its start and end offsets. */
function packageTable(text) {
  const header = /^\[package\][ \t]*$/m.exec(text)
  if (!header) throw new Error('Cargo.toml has no [package] table')
  const start = header.index
  const next = /^\[/m.exec(text.slice(start + header[0].length))
  const end = next ? start + header[0].length + next.index : text.length
  return { start, end }
}

/** The `version` of a Cargo.toml's [package] table. */
function readCargoVersion(text) {
  const { start, end } = packageTable(text)
  const match = CARGO_VERSION.exec(text.slice(start, end))
  if (!match) throw new Error('Cargo.toml has no literal `version = "…"` in [package]')
  return match[2]
}

/** Sets the `version` of a Cargo.toml's [package] table; nothing else changes. */
function setCargoVersion(text, version) {
  readCargoVersion(text)
  const { start, end } = packageTable(text)
  return text.slice(0, start) + text.slice(start, end).replace(CARGO_VERSION, `$1${version}$3`) + text.slice(end)
}

/** Sets a JSON file's top-level "version" (tauri.conf.json); nothing else changes. */
function setJsonVersion(text, version) {
  const current = JSON.parse(text).version
  if (typeof current !== 'string') throw new Error('the JSON file has no top-level "version" string')
  const escaped = current.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`("version"\\s*:\\s*")${escaped}(")`, 'g')
  const matches = text.match(pattern) ?? []
  if (matches.length !== 1) {
    throw new Error(`"version": "${current}" appears ${matches.length} times; refusing to guess which one to change`)
  }
  return text.replace(pattern, `$1${version}$2`)
}

/**
 * Sets the versions of the named path (workspace) crates in a Cargo.lock. Only entries without
 * a `source` line are touched: registry crates never are, whatever their name.
 */
function setLockVersions(text, versions) {
  return text.replace(
    /^\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]*)"\n(?!source = )/gm,
    (entry, name, current) =>
      Object.hasOwn(versions, name) ? entry.replace(`version = "${current}"`, `version = "${versions[name]}"`) : entry,
  )
}

/** Each workspace crate's name and version, read from crates/<dir>/Cargo.toml on disk. */
function crateVersions(root) {
  const versions = {}
  const crates = path.join(root, 'crates')
  for (const dir of fs.readdirSync(crates)) {
    const manifest = path.join(crates, dir, 'Cargo.toml')
    if (!fs.existsSync(manifest)) continue
    const text = fs.readFileSync(manifest, 'utf8')
    const { start, end } = packageTable(text)
    const name = /^name\s*=\s*"([^"]+)"/m.exec(text.slice(start, end))
    if (name) versions[name[1]] = readCargoVersion(text)
  }
  return versions
}

/** The Cargo.lock files that hold workspace crates: the root one and the shell's own. */
const LOCKFILES = ['Cargo.lock', 'crates/trivia_shell/Cargo.lock']

class TriviaVersionActions extends JsVersionActions {
  async init(tree) {
    const root = this.projectGraphNode.data.root
    const at = (file) => (tree.exists(path.join(root, file)) ? path.join(root, file) : null)
    this.cargoManifest = at('Cargo.toml')
    this.tauriConfig = this.cargoManifest ? at('tauri.conf.json') : null
    this.cargoOnly = !at('package.json')
    if (this.cargoOnly) {
      if (!this.cargoManifest) {
        throw new Error(`Project "${this.projectGraphNode.name}" has neither a package.json nor a Cargo.toml in ${root}`)
      }
      this.validManifestFilenames = ['Cargo.toml']
    }
    await super.init(tree)
  }

  async readCurrentVersionFromSourceManifest(tree) {
    if (!this.cargoOnly) return super.readCurrentVersionFromSourceManifest(tree)
    return { manifestPath: this.cargoManifest, currentVersion: readCargoVersion(tree.read(this.cargoManifest, 'utf-8')) }
  }

  async readCurrentVersionFromRegistry(tree, metadata) {
    if (!this.cargoOnly) return super.readCurrentVersionFromRegistry(tree, metadata)
    throw new Error(`Crate "${this.projectGraphNode.name}" is not published; resolve its version from the git tag`)
  }

  async readCurrentVersionOfDependency(tree, projectGraph, dependencyProjectName) {
    if (!this.cargoOnly) return super.readCurrentVersionOfDependency(tree, projectGraph, dependencyProjectName)
    return { currentVersion: null, dependencyCollection: null }
  }

  async updateProjectVersion(tree, newVersion) {
    const log = this.cargoOnly ? [] : await super.updateProjectVersion(tree, newVersion)
    for (const [file, edit] of [
      [this.cargoManifest, setCargoVersion],
      [this.tauriConfig, setJsonVersion],
    ]) {
      if (!file) continue
      tree.write(file, edit(tree.read(file, 'utf-8'), newVersion))
      log.push(`✍️  New version ${newVersion} written to manifest: ${file}`)
    }
    return log
  }

  async updateProjectDependencies(tree, projectGraph, dependenciesToUpdate, resolveVersionForDependency) {
    if (this.cargoOnly) return []
    return super.updateProjectDependencies(tree, projectGraph, dependenciesToUpdate, resolveVersionForDependency)
  }
}

/**
 * After every manifest is written: pnpm's lockfile (as @nx/js does), then each Cargo.lock entry
 * for a workspace crate, so `cargo --locked` agrees with the new versions.
 */
async function afterAllProjectsVersioned(cwd, options) {
  const js = await afterJsProjectsVersioned(cwd, options)
  const changedFiles = [...js.changedFiles]
  if (!options.dryRun) {
    const versions = crateVersions(cwd)
    for (const lockfile of LOCKFILES) {
      const file = path.join(cwd, lockfile)
      if (!fs.existsSync(file)) continue
      const before = fs.readFileSync(file, 'utf8')
      const after = setLockVersions(before, versions)
      if (after !== before) {
        fs.writeFileSync(file, after)
        changedFiles.push(lockfile)
      }
    }
  }
  return { changedFiles, deletedFiles: js.deletedFiles }
}

module.exports = TriviaVersionActions
module.exports.default = TriviaVersionActions
module.exports.afterAllProjectsVersioned = afterAllProjectsVersioned
module.exports.readCargoVersion = readCargoVersion
module.exports.setCargoVersion = setCargoVersion
module.exports.setJsonVersion = setJsonVersion
module.exports.setLockVersions = setLockVersions
module.exports.crateVersions = crateVersions
