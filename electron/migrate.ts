import fs from 'node:fs'
import path from 'node:path'

export interface LegacyLocations {
  /** `$HERMES_HOME`. */
  hermesHome: string
  /** Electron's `appData` (`~/Library/Application Support`, `~/.config`). */
  appData: string
  /** Electron's `userData` for Veritas OS. */
  userData: string
}

/** Web partitions inside the Chromium profile, by pre-rename name. */
const PARTITIONS = ['web', 'viewer', 'preview']

function exists(target: string): boolean {
  try {
    fs.lstatSync(target)

    return true
  } catch {
    return false
  }
}

function isEmptyDir(target: string): boolean {
  try {
    return fs.lstatSync(target).isDirectory() && fs.readdirSync(target).length === 0
  } catch {
    return false
  }
}

function moveIfMissing(from: string, to: string, moved: string[]): void {
  if (!exists(from)) {
    return
  }

  // `app.getPath('userData')` creates the folder, so an empty one is not a profile to keep.
  if (exists(to)) {
    if (!isEmptyDir(to)) {
      return
    }

    fs.rmdirSync(to)
  }

  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.renameSync(from, to)
  moved.push(`${from} -> ${to}`)
}

/** Moves entries the new folder lacks; a second process may already have created it. */
function mergeInto(from: string, to: string, moved: string[]): void {
  if (!exists(from) || fs.lstatSync(from).isSymbolicLink()) {
    return
  }

  if (!exists(to)) {
    moveIfMissing(from, to, moved)

    return
  }

  for (const name of fs.readdirSync(from)) {
    moveIfMissing(path.join(from, name), path.join(to, name), moved)
  }

  if (fs.readdirSync(from).length === 0) {
    fs.rmdirSync(from)
  }
}

/**
 * Carries data over from the pre-rename "Hermes OS" locations: the shell's folder in the Hermes home
 * (prefs, permission policy, audit log) and the Chromium profile (local storage, web-window logins).
 * Must run before anything opens the profile; the single-instance lock writes into `userData`.
 */
export function migrateLegacyData(locations: LegacyLocations): string[] {
  const moved: string[] = []
  const attempt = (step: () => void) => {
    try {
      step()
    } catch (error) {
      moved.push(`failed: ${String(error)}`)
    }
  }

  attempt(() => mergeInto(path.join(locations.hermesHome, 'hermes-os'), path.join(locations.hermesHome, 'herald-os'), moved))
  attempt(() => moveIfMissing(path.join(locations.appData, 'Hermes OS'), locations.userData, moved))

  for (const name of PARTITIONS) {
    attempt(() => moveIfMissing(path.join(locations.userData, 'Partitions', `hermes-${name}`), path.join(locations.userData, 'Partitions', `herald-${name}`), moved))
  }

  return moved
}
