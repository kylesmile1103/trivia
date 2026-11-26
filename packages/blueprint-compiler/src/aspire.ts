// The Aspire CLI the generated solutions are verified with (LLD-10). With AspireUseCliBundle the CLI supplies
// the orchestrator and dashboard, so a CLI of another major or minor version is untested against the
// 13.6.5 hosting packages the solution pins.

export const ASPIRE_VERSION = '13.6.5'

/** The pinned install, as CI runs it. */
export const ASPIRE_INSTALL = [
  'curl -fsSL https://aspire.dev/install.sh -o aspire-install.sh',
  `bash aspire-install.sh --version ${ASPIRE_VERSION}`,
] as const

const install = ASPIRE_INSTALL.map((line) => '  ' + line).join('\n')

/** What `aspire --version` printed, checked against the pin: an error to stop on, a warning, or nothing. */
export function checkAspireVersion(output: string): { error: string } | { warning: string } | null {
  const found = /(\d+)\.(\d+)\.(\d+)/.exec(output)
  if (!found) {
    return { warning: `Warning: could not read the Aspire CLI version from "${output.trim()}". This solution uses Aspire ${ASPIRE_VERSION}:\n${install}` }
  }
  const [pinnedMajor, pinnedMinor] = ASPIRE_VERSION.split('.')
  if (found[1] === pinnedMajor && found[2] === pinnedMinor) return null
  return {
    error: `This solution is pinned to Aspire ${ASPIRE_VERSION}, but the Aspire CLI ${found[0]} is on PATH. The CLI supplies ` +
      `the orchestrator and dashboard, and ${found[1]}.${found[2]} is untested with the ${ASPIRE_VERSION} packages. ` +
      `Install the pinned CLI:\n${install}`,
  }
}

export const ASPIRE_MISSING = 'Warning: the Aspire CLI is not on PATH. Backend generation does not need it; running ' +
  `the solution with aspire run does. Install Aspire ${ASPIRE_VERSION}:\n${install}`

export const ASPIRE_NEXT_STEPS = `Install the pinned Aspire CLI (${ASPIRE_VERSION}) to run the solution:\n${install}`
