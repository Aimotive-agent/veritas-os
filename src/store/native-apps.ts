import { useStore } from '@nanostores/react'
import { atom, map } from 'nanostores'
import { useCallback, useEffect } from 'react'
import type { InstalledApp } from '../../shared/ipc.ts'

export const $nativeApps = atom<InstalledApp[]>([])
/** Icon data URLs by app path; `''` once an app is known to have none. */
export const $nativeIcons = map<Record<string, string>>({})
const requested = new Set<string>()
let loaded = false

export function loadNativeApps(): void {
  if (loaded) {
    return
  }

  loaded = true
  void window.heraldOS.apps
    .list()
    .then(apps => $nativeApps.set(apps))
    .catch(() => {
      loaded = false
    })
}

export function requestIcon(appPath: string): void {
  if (requested.has(appPath)) {
    return
  }

  requested.add(appPath)
  void window.heraldOS.apps
    .icon(appPath)
    .then(url => $nativeIcons.setKey(appPath, url))
    .catch(() => $nativeIcons.setKey(appPath, ''))
}

/** Installed apps with lazily fetched icons; shared by the dock, launcher and command bar. */
export function useNativeApps() {
  const apps = useStore($nativeApps)
  const icons = useStore($nativeIcons)

  useEffect(loadNativeApps, [])

  const iconFor = useCallback(
    (appPath?: string): string | undefined => {
      if (!appPath) {
        return undefined
      }

      const cached = icons[appPath]

      if (!cached) {
        requestIcon(appPath)
      }

      return cached
    },
    [icons]
  )

  return { apps, iconFor }
}

export function findNativeApp(names: string[]): InstalledApp | undefined {
  const apps = $nativeApps.get()

  for (const name of names) {
    const found = apps.find(a => a.name === name)

    if (found) {
      return found
    }
  }

  return undefined
}
