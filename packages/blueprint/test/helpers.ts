// Test helpers: reading fixture directories and rendering file writes as line diffs.
import fs from 'node:fs'
import path from 'node:path'

export const FIXTURES = path.resolve(import.meta.dirname, '../fixtures')

/** Every file under `dir` except expected.json, keyed by its `/`-separated relative path. */
export function readFixture(dir: string): Record<string, string> {
  const files: Record<string, string> = {}
  if (!fs.existsSync(dir)) return files
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || entry.name === 'expected.json') continue
    const full = path.join(entry.parentPath, entry.name)
    files[path.relative(dir, full).split(path.sep).join('/')] = fs.readFileSync(full, 'utf8')
  }
  return files
}

/**
 * The lines `after` removes from and adds to `before`, by longest common subsequence: `-` and
 * `+` lines only, deletions before insertions in each changed region.
 */
export function lineDiff(before: string, after: string): string[] {
  const a = before.split('\n')
  const b = after.split('\n')
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }
  const out: string[] = []
  let removed: string[] = []
  let added: string[] = []
  const flush = () => {
    out.push(...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`))
    removed = []
    added = []
  }
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      flush()
      i++
      j++
    } else if (j >= b.length || (i < a.length && lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) removed.push(a[i++]!)
    else added.push(b[j++]!)
  }
  flush()
  return out
}

export interface Write {
  file: string
  before: string | null
  after: string | null
}

const pageId = (text: string | null): string | undefined => {
  try {
    return text === null ? undefined : (JSON.parse(text) as { id?: string }).id
  } catch {
    return undefined
  }
}

/**
 * Writes as a diff, one block per file in path order. A page deleted and created with the same
 * id is a rename and shows as one block from the old path to the new one.
 */
export function renderWrites(writes: readonly Write[]): string {
  const created = writes.filter((w) => w.before === null)
  const renamed = new Map<string, Write>()
  for (const w of writes) {
    if (w.after !== null) continue
    const target = created.find((c) => pageId(c.after) !== undefined && pageId(c.after) === pageId(w.before))
    if (target) renamed.set(w.file, target)
  }
  const targets = new Set([...renamed.values()].map((w) => w.file))
  let out = ''
  for (const w of [...writes].sort((x, y) => (x.file < y.file ? -1 : 1))) {
    if (targets.has(w.file)) continue
    const target = renamed.get(w.file)
    if (target) {
      out += `--- a/${w.file}\n+++ b/${target.file}\n` + lineDiff(w.before ?? '', target.after ?? '').map((l) => l + '\n').join('')
    } else if (w.before === null) {
      out += `--- /dev/null\n+++ b/${w.file}\n` + (w.after ?? '').split('\n').slice(0, -1).map((l) => `+${l}\n`).join('')
    } else if (w.after === null) {
      out += `--- a/${w.file}\n+++ /dev/null\n`
    } else {
      out += `--- a/${w.file}\n+++ b/${w.file}\n` + lineDiff(w.before, w.after).map((l) => l + '\n').join('')
    }
  }
  return out
}
