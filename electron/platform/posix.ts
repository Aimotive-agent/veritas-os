import path from 'node:path'
import type { DiskUsage, ProcessInfo } from '../../shared/ipc.ts'

/** Mount points macOS users care about: the root volume and non-hidden `/Volumes/*` entries. */
export function isDarwinUserMount(mount: string): boolean {
  return mount === '/' || (mount.startsWith('/Volumes/') && !mount.startsWith('/Volumes/.'))
}

/**
 * Parse POSIX `df -kP` output into mounted volumes. `keepMount` decides which mount points survive;
 * it defaults to the macOS rule (root + `/Volumes/*`) because `darwin.ts` re-exports this parser
 * under its historical signature. Linux passes its own predicate and post-filters.
 */
export function parseDf(text: string, keepMount: (mount: string) => boolean = isDarwinUserMount): DiskUsage[] {
  const disks: DiskUsage[] = []

  for (const line of text.split('\n').slice(1)) {
    const parts = line.trim().split(/\s+/)

    if (parts.length < 6) {
      continue
    }

    const mount = parts.slice(5).join(' ')
    const total = Number(parts[1]) * 1024
    const free = Number(parts[3]) * 1024
    // APFS: "Used" on `/` counts only the sealed system volume; the container's real usage is
    // total minus the space still available to it. The same derivation is correct on Linux.
    const used = Math.max(0, total - free)

    if (!Number.isFinite(total) || total <= 0) {
      continue
    }

    if (keepMount(mount)) {
      disks.push({ mount, total, used, free })
    }
  }

  return disks
}

/** Parse `ps -o pid=,ppid=,user=,%cpu=,%mem=,rss=,comm=` rows (`-Ax` on macOS, `-e` on Linux). */
export function parsePs(text: string): ProcessInfo[] {
  const rows: ProcessInfo[] = []

  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(.*)$/.exec(line)

    if (!match) {
      continue
    }

    const command = match[7].trim()
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      user: match[3],
      cpuPercent: Number(match[4]),
      memPercent: Number(match[5]),
      rssBytes: Number(match[6]) * 1024,
      command,
      name: path.basename(command)
    })
  }

  return rows
}
