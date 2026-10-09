// `pnpm release:desktop v<version>`: builds the desktop app (`nx run shell:bundle`) and attaches
// its .dmg to that GitHub release, with a note on how to open it. `pnpm release` runs it after
// creating the release; run it by hand when that step failed. Running it again replaces the
// asset and keeps one note.
//
// macOS only (the shell is verified there). The app is ad-hoc signed, not notarized: there is no
// Apple Developer ID here, so macOS asks the user to allow it once.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { github, githubRepo, githubToken } from './github.mjs'

const NOTE_MARKER = '<!-- trivia:desktop-app -->'

/** The .dmg `tauri build` wrote for this version, among the files in the bundle's dmg folder. */
export function findDmg(files, version) {
  const matches = files.filter((file) => file.startsWith(`Trivia_${version}_`) && file.endsWith('.dmg'))
  if (matches.length !== 1) {
    throw new Error(`expected one Trivia_${version}_<arch>.dmg, found ${matches.length ? matches.join(', ') : 'none'}`)
  }
  return matches[0]
}

/** The release-notes section for the desktop app. */
export function desktopNote(dmg) {
  return [
    NOTE_MARKER,
    '### Desktop app (macOS, Apple silicon)',
    '',
    `\`${dmg}\` is Trivia's desktop window: open it, drag Trivia to Applications.`,
    '',
    '- It is a window on the designer, so the designer must run: `pnpm dev` in this repository',
    '  (the window waits for it, then opens it).',
    '- It is ad-hoc signed, not notarized. The first time, macOS refuses to open it: allow it in',
    '  System Settings → Privacy & Security → "Open Anyway", or run',
    '  `xattr -dr com.apple.quarantine /Applications/Trivia.app`.',
  ].join('\n')
}

/** The release body with the desktop note, once: a re-run replaces the earlier note. */
export function withDesktopNote(body, note) {
  const kept = (body ?? '').split(NOTE_MARKER)[0].trimEnd()
  return `${kept}\n\n${note}\n`
}

export async function attachDesktopApp(root, tag, { log = console.log } = {}) {
  if (process.platform !== 'darwin') throw new Error('the desktop app is bundled on macOS only')
  const version = tag.replace(/^v/, '')
  const shellConfig = JSON.parse(fs.readFileSync(path.join(root, 'crates/trivia_shell/tauri.conf.json'), 'utf8'))
  if (shellConfig.version !== version) {
    throw new Error(`crates/trivia_shell/tauri.conf.json is at ${shellConfig.version}, not ${version}: check out ${tag} first`)
  }
  const token = githubToken(root)
  if (!token) throw new Error('no GitHub token (GH_TOKEN, GITHUB_TOKEN or git\'s credential helper)')
  const { owner, repo } = githubRepo(root)
  const release = await github(token, 'GET', `/repos/${owner}/${repo}/releases/tags/${tag}`)

  log(`Building the desktop app for ${tag} (nx run shell:bundle)…`)
  execFileSync(path.join(root, 'node_modules', '.bin', 'nx'), ['run', 'shell:bundle', '--outputStyle=stream'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, NX_TUI: 'false' },
  })
  const dmgDir = path.join(root, 'crates/trivia_shell/target/release/bundle/dmg')
  const dmg = findDmg(fs.readdirSync(dmgDir), version)

  for (const asset of release.assets.filter((a) => a.name === dmg)) {
    await github(token, 'DELETE', `/repos/${owner}/${repo}/releases/assets/${asset.id}`)
  }
  const uploaded = await github(
    token,
    'POST',
    `https://uploads.github.com/repos/${owner}/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(dmg)}`,
    { body: fs.readFileSync(path.join(dmgDir, dmg)), headers: { 'Content-Type': 'application/x-apple-diskimage' } },
  )
  await github(token, 'PATCH', `/repos/${owner}/${repo}/releases/${release.id}`, {
    body: JSON.stringify({ body: withDesktopNote(release.body, desktopNote(dmg)) }),
    headers: { 'Content-Type': 'application/json' },
  })
  log(`Attached ${dmg} (${(uploaded.size / 1e6).toFixed(1)} MB) to ${release.html_url}`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tag = process.argv[2]
  if (!tag || !/^v\d+\.\d+\.\d+/.test(tag)) {
    console.error('usage: pnpm release:desktop v<version>')
    process.exit(2)
  }
  attachDesktopApp(path.resolve(import.meta.dirname, '../..'), tag).catch((error) => {
    console.error(`release:desktop: ${error.message}`)
    process.exit(1)
  })
}
