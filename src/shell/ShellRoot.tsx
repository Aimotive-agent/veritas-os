import { type ComponentType, lazy, Suspense } from 'react'
import { surface } from '../store/shell.ts'
import { App } from './App.tsx'

// Panels-mode surfaces load lazily: each Electron window renders exactly one of them.
const MenuBarSurface = lazy(() => import('./surfaces/MenuBarSurface.tsx').then(m => ({ default: m.MenuBarSurface })))
const DockSurface = lazy(() => import('./surfaces/DockSurface.tsx').then(m => ({ default: m.DockSurface })))
const MainSurface = lazy(() => import('./surfaces/MainSurface.tsx').then(m => ({ default: m.MainSurface })))
const CommandSurface = lazy(() => import('./surfaces/CommandSurface.tsx').then(m => ({ default: m.CommandSurface })))
const StatusPanelSurface = lazy(() => import('./surfaces/StatusPanelSurface.tsx').then(m => ({ default: m.StatusPanelSurface })))
const ScreensaverSurface = lazy(() => import('./surfaces/ScreensaverSurface.tsx').then(m => ({ default: m.ScreensaverSurface })))
const WallpaperSurface = lazy(() => import('./surfaces/WallpaperSurface.tsx').then(m => ({ default: m.WallpaperSurface })))
const FloatingSurface = lazy(() => import('./surfaces/FloatingSurface.tsx').then(m => ({ default: m.FloatingSurface })))
const EmojiSurface = lazy(() => import('./surfaces/EmojiSurface.tsx').then(m => ({ default: m.EmojiSurface })))

const SURFACES: Record<string, ComponentType> = {
  menubar: MenuBarSurface,
  dock: DockSurface,
  main: MainSurface,
  command: CommandSurface,
  panel: StatusPanelSurface,
  screensaver: ScreensaverSurface,
  wallpaper: WallpaperSurface,
  emoji: EmojiSurface
}

/** Picks what this renderer window shows: the whole desktop (desktop mode) or one panels-mode surface. */
export function ShellRoot() {
  if (surface === 'desktop') {
    return <App />
  }

  if (surface.startsWith('window:')) {
    return (
      <Suspense fallback={null}>
        <FloatingSurface appId={surface.slice('window:'.length)} />
      </Suspense>
    )
  }

  const View = SURFACES[surface] ?? App

  return (
    <Suspense fallback={null}>
      <View />
    </Suspense>
  )
}
