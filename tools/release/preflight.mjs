// Checks `pnpm release` runs before `nx release`.
import { spawnSync } from 'node:child_process'
import path from 'node:path'

import { missingMvpPrerequisite } from '../blueprint/mvp-project.mjs'

/** Nx's commit-subject pattern (nx/src/command-line/release/utils/git.js, 23.2.1). */
export const COMMIT_SUBJECT = /^(?<type>[^\s():!]+)(?:\s*\((?<scope>.+)\))?(?<breaking>!)?: (?<description>.+)$/u

/** The type Nx reads from a commit subject: its prefix, or `__INVALID__` when it has none. */
export function commitType(subject) {
  return COMMIT_SUBJECT.exec(subject)?.groups?.type ?? '__INVALID__'
}

/**
 * Subjects whose type Nx doesn't know, grouped by type. Nx drops a commit of an unknown type
 * from the changelog, so a new prefix ("inspector: …") would vanish from the release notes.
 */
export function unknownCommitTypes(subjects, knownTypes) {
  const unknown = new Map()
  for (const subject of subjects) {
    const type = commitType(subject)
    if (knownTypes.has(type)) continue
    unknown.set(type, [...(unknown.get(type) ?? []), subject])
  }
  return unknown
}


export function checkMvpBeforeRelease(root, env, prerequisite = missingMvpPrerequisite, run = spawnSync) {
  const missing = prerequisite()
  if (missing) throw new Error(missing)
  const result = run(path.join(root, 'node_modules', '.bin', 'nx'), ['run', 'tools:mvp'], {
    cwd: root, env: { ...env, TRIVIA_MVP_REQUIRED: '1' }, stdio: 'inherit',
  })
  if (result.error || result.status !== 0) {
    const reason = result.error?.message ?? result.signal ?? 'exit ' + result.status
    throw new Error(`MVP acceptance failed (${reason}).`)
  }
}
