/**
 * Reads `HERALD_OS_<name>`. The pre-rename `HERMES_OS_<name>` is still honoured so launch scripts
 * written before the project became Veritas OS keep working.
 */
export function osEnv(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[`HERALD_OS_${name}`] ?? env[`HERMES_OS_${name}`]
}
