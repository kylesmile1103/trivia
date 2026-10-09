// What the release scripts need from GitHub: the repository, a token and its REST API.
import { execFileSync, spawnSync } from 'node:child_process'

/** `{ owner, repo }` from a GitHub remote URL (https or ssh), else null. */
export function parseGitHubRemote(url) {
  const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim())
  return match ? { owner: match[1], repo: match[2] } : null
}

/** The GitHub repository `origin` points at. */
export function githubRepo(root) {
  const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' })
  const repo = parseGitHubRemote(url)
  if (!repo) throw new Error(`origin (${url.trim()}) is not a GitHub repository`)
  return repo
}

/** GH_TOKEN, GITHUB_TOKEN, else the token git's credential helper keeps for github.com, else null. */
export function githubToken(root, env = process.env) {
  if (env.GH_TOKEN || env.GITHUB_TOKEN) return env.GH_TOKEN || env.GITHUB_TOKEN
  const credential = spawnSync('git', ['credential', 'fill'], {
    cwd: root,
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
    env: { ...env, GIT_TERMINAL_PROMPT: '0' },
  })
  return /^password=(.+)$/m.exec(credential.stdout ?? '')?.[1] ?? null
}

/** One GitHub REST call; throws with GitHub's message when it fails. */
export async function github(token, method, url, { body, headers = {} } = {}) {
  const response = await fetch(url.startsWith('https://') ? url : `https://api.github.com${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...headers,
    },
    body,
  })
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`GitHub ${method} ${url}: ${response.status} ${detail.slice(0, 300)}`)
  }
  return response.status === 204 ? null : response.json()
}
