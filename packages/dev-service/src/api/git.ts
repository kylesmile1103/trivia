// The git-dirty guard (docs/mcp.md): before regenerating code that replaces files wholesale,
// say which of them hold uncommitted changes instead of overwriting them. Trivia never stashes,
// commits or checks out anything: git is the user's.

import { execFile } from 'node:child_process'

/**
 * Project-relative paths under `paths` with uncommitted changes (modified, added, deleted or
 * untracked), or null when `root` isn't in a git work tree or git isn't installed.
 */
export function uncommitted(root: string, paths: readonly string[]): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile('git', ['status', '--porcelain=v1', '--untracked-files=all', '--', ...paths], { cwd: root, timeout: 10_000 }, (error, stdout) => {
      if (error) {
        resolve(null)
        return
      }
      const files = stdout
        .split('\n')
        .filter((line) => line.length > 3)
        .map((line) => {
          const entry = line.slice(3)
          const arrow = entry.indexOf(' -> ')
          return arrow >= 0 ? entry.slice(arrow + 4) : entry
        })
      resolve(files)
    })
  })
}
