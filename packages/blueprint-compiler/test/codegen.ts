import { execFileSync, spawnSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const project = fileURLToPath(new URL('../../../dotnet/src/Trivia.Blueprint.Codegen/Trivia.Blueprint.Codegen.csproj', import.meta.url))

/**
 * Builds the .NET generator once, from the vitest global setup. Several test files run it at
 * the same time, and concurrent `dotnet run` builds of one project raced on its Release output
 * ("The application to execute does not exist").
 */
export function buildCodegen(): void {
  if (spawnSync('dotnet', ['--version'], { stdio: 'ignore' }).status !== 0) return
  const build = spawnSync('dotnet', ['build', project, '--configuration', 'Release', '--disable-build-servers', '--nologo'],
    { encoding: 'utf8', timeout: 300_000 })
  if (build.status !== 0) throw new Error(`Building the .NET generator failed\n${build.stdout}${build.stderr}`)
}

/** Runs the generator that the global setup built, without building it again. */
export function runCodegen(args: string[], options: ExecFileSyncOptionsWithStringEncoding): string {
  return execFileSync('dotnet', ['run', '--project', project, '--configuration', 'Release', '--no-build', '--', ...args], options)
}
