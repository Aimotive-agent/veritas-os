/**
 * Variables that tie a process to a Hermes session, or to a Veritas OS backend. Hermes passes a turn's
 * HERMES_SESSION_* on to every command the turn runs, and a process that binds no session of its own
 * (the `hermes` CLI) takes them as its own: a Veritas OS started by such a command would hand that
 * session, and the backend's HERALD_OS markers, to its backend and to every terminal and app it opens.
 * The names are Hermes's session context (gateway/session_context.py) and its per-run markers.
 */
const INHERITED = /^(HERMES_SESSION_|HERMES_CRON_AUTO_DELIVER_|HERMES_BROWSER_CONTROL_)|^(HERMES_UI_SESSION_ID|HERMES_CRON_SESSION|HERMES_SINGLE_QUERY_SESSION|HERMES_KANBAN_TASK|HERALD_OS|HERALD_OS_CONTROL_SOCKET|HERALD_OS_CONTROL_TOKEN)$/

export function isInheritedSessionVariable(name: string): boolean {
  return INHERITED.test(name)
}

/** `env` without a session or backend identity it inherited. */
export function withoutInheritedSession(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !INHERITED.test(name)))
}

/** Removes them from this process's own environment, which everything it starts inherits; returns their names. */
export function forgetInheritedSession(env: NodeJS.ProcessEnv = process.env): string[] {
  const names = Object.keys(env).filter(name => INHERITED.test(name))

  for (const name of names) {
    delete env[name]
  }

  return names
}
