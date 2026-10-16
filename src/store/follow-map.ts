import type { ToolCompletePayload } from '@herald-os/client'

/** Tools that mean Hermes is building something the Studio can show (code, commands). */
export function isBuildActivity(name: string | undefined): boolean {
  return name === 'write_file' || name === 'patch' || name === 'terminal'
}

/** Which registry command shows the result of a built-in tool call; null when nothing to show. Pure. */
export function followCommandFor(payload: Pick<ToolCompletePayload, 'name' | 'args'>): { command: string; args: Record<string, unknown> } | null {
  const name = payload.name ?? ''
  const args = (payload.args ?? {}) as Record<string, unknown>
  const action = String(args.action ?? '').toLowerCase()

  if (name === 'memory') {
    if (action === 'add' || action === 'replace' || action === 'remove') {
      const text = String(args.content ?? args.new_content ?? '').trim()

      return { command: 'memory.show', args: text && action !== 'remove' ? { query: text.slice(0, 60) } : {} }
    }

    return null
  }

  if (name === 'cronjob') {
    const jobName = String(args.name ?? '').trim()

    if (action === 'create' || action === 'pause' || action === 'resume' || action === 'update') {
      return jobName ? { command: 'automation.show', args: { name: jobName } } : { command: 'automation.list', args: {} }
    }

    if (action === 'remove' || action === 'delete' || action === 'list') {
      return { command: 'automation.list', args: {} }
    }

    return null
  }

  if (name === 'write_file' || name === 'create_folder' || name === 'system_files') {
    const path = String(args.path ?? args.file_path ?? args.dir ?? '').trim()
    const parent = path.replace(/\/[^/]+\/?$/, '')

    return parent ? { command: 'files.open', args: { place: parent } } : null
  }

  return null
}
