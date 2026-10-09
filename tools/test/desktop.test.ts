import { describe, expect, it } from 'vitest'

import { desktopNote, findDmg, withDesktopNote } from '../release/desktop.mjs'
import { parseGitHubRemote } from '../release/github.mjs'

describe('the GitHub repository', () => {
  it('comes from an https or ssh remote', () => {
    const repo = { owner: 'kylesmile1103', repo: 'trivia' }
    expect(parseGitHubRemote('https://github.com/kylesmile1103/trivia.git\n')).toEqual(repo)
    expect(parseGitHubRemote('git@github.com:kylesmile1103/trivia.git')).toEqual(repo)
    expect(parseGitHubRemote('https://github.com/kylesmile1103/trivia')).toEqual(repo)
    expect(parseGitHubRemote('/Users/someone/trivia')).toBeNull()
  })
})

describe('the desktop asset', () => {
  it("is the version's .dmg, never an older build's", () => {
    const files = ['Trivia.icns', 'Trivia_0.1.0_aarch64.dmg', 'Trivia_0.2.0_aarch64.dmg', 'bundle_dmg.sh']
    expect(findDmg(files, '0.2.0')).toBe('Trivia_0.2.0_aarch64.dmg')
    expect(() => findDmg(files, '0.3.0')).toThrow(/found none/)
  })

  it('adds its note to the release body once, however often it runs', () => {
    const note = desktopNote('Trivia_0.2.0_aarch64.dmg')
    expect(note).toContain('Open Anyway')
    expect(note).toContain('pnpm dev')
    const once = withDesktopNote('## 0.2.0\n\n### Repo\n\n- a change', note)
    expect(withDesktopNote(once, note)).toBe(once)
    expect(once.startsWith('## 0.2.0\n\n### Repo\n\n- a change\n\n<!-- trivia:desktop-app -->')).toBe(true)
  })
})
