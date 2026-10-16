/*
 * What Hermes's `system_files` tool leaves on disk, read from its arguments: created folders and
 * where moves and copies land. A move's source and anything trashed are gone afterwards.
 */

const HAS_EXTENSION = /\.[a-z0-9]{1,6}$/i

/**
 * Where `path` lands when moved or copied to `to`. The bridge moves into `to` when it is an existing
 * folder; without the disk to ask, a trailing slash or a last segment without an extension reads as one.
 */
export function landingPath(path: string, to: string): string {
  const folder = to.replace(/\/+$/, '')
  const name = path.replace(/\/+$/, '').split('/').pop() ?? path

  return to.endsWith('/') || !HAS_EXTENSION.test(folder.split('/').pop() ?? '') ? `${folder}/${name}` : to
}

export function systemFilesOutputs(args: Record<string, unknown> | null | undefined): string[] {
  if (!args) {
    return []
  }

  const ops: unknown[] = args.action === 'batch' ? (Array.isArray(args.operations) ? args.operations : []) : [{ ...args, op: args.action }]
  const out: string[] = []

  for (const raw of ops) {
    if (!raw || typeof raw !== 'object') {
      continue
    }

    const { op, path, to } = raw as Record<string, unknown>

    if (typeof path !== 'string') {
      continue
    }

    if (op === 'mkdir') {
      out.push(path)
    } else if ((op === 'move' || op === 'copy') && typeof to === 'string') {
      out.push(landingPath(path, to))
    }
  }

  return out.filter(p => p.startsWith('/') || p.startsWith('~'))
}
