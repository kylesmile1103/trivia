import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const actions = createRequire(import.meta.url)('../release/version-actions.cjs')
const repo = path.resolve(import.meta.dirname, '../..')
const read = (file: string) => fs.readFileSync(path.join(repo, file), 'utf8')

/** The lines that differ between two texts of the same line count. */
function changedLines(before: string, after: string): string[] {
  const a = before.split('\n')
  const b = after.split('\n')
  expect(b.length).toBe(a.length)
  return b.filter((line, i) => line !== a[i])
}

describe('Cargo.toml', () => {
  it.each(['crates/trivia_oxc_engine/Cargo.toml', 'crates/trivia_napi/Cargo.toml', 'crates/trivia_shell/Cargo.toml'])(
    'changes only the [package] version line of %s',
    (file) => {
      const before = read(file)
      const after = actions.setCargoVersion(before, '9.8.7')
      expect(changedLines(before, after)).toEqual(['version = "9.8.7"'])
      expect(actions.readCargoVersion(after)).toBe('9.8.7')
    },
  )

  it('leaves versions in other tables alone', () => {
    const text = '[package]\nname = "x"\nversion = "0.1.0"\n\n[dependencies]\ny = { version = "0.1.0" }\n'
    expect(actions.setCargoVersion(text, '0.2.0')).toBe(text.replace('version = "0.1.0"\n\n', 'version = "0.2.0"\n\n'))
  })

  it('refuses a version it cannot write in place', () => {
    expect(() => actions.setCargoVersion('[package]\nname = "x"\nversion.workspace = true\n', '1.0.0')).toThrow(
      /no literal `version = "…"`/,
    )
    expect(() => actions.setCargoVersion('[workspace]\nmembers = []\n', '1.0.0')).toThrow(/no \[package\] table/)
  })
})

describe('tauri.conf.json', () => {
  it('changes only its top-level version', () => {
    const before = read('crates/trivia_shell/tauri.conf.json')
    const after = actions.setJsonVersion(before, '9.8.7')
    expect(changedLines(before, after)).toEqual(['  "version": "9.8.7",'])
  })

  it('refuses to guess when the version string appears twice', () => {
    expect(() => actions.setJsonVersion('{ "version": "1.0.0", "x": { "version": "1.0.0" } }', '2.0.0')).toThrow(/2 times/)
  })
})

describe('Cargo.lock', () => {
  it('moves only the workspace crates of the root lockfile', () => {
    const before = read('Cargo.lock')
    const after = actions.setLockVersions(before, { trivia_napi: '9.8.7', trivia_oxc_engine: '9.8.7' })
    expect(changedLines(before, after)).toEqual(['version = "9.8.7"', 'version = "9.8.7"'])
  })

  it('never touches a registry crate, whatever its name', () => {
    const lock = '[[package]]\nname = "trivia_napi"\nversion = "0.1.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n'
    expect(actions.setLockVersions(lock, { trivia_napi: '9.8.7' })).toBe(lock)
  })

  it('reads every crate version from crates/*/Cargo.toml', () => {
    const versions = actions.crateVersions(repo)
    expect(Object.keys(versions).sort()).toEqual(['trivia_napi', 'trivia_oxc_engine', 'trivia_shell'])
    expect(new Set(Object.values(versions)).size).toBe(1)
  })
})
