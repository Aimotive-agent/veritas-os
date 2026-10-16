import { Screensaver } from '../../features/screensaver/Screensaver.tsx'
import { closeThisSurface } from '../../store/shell.ts'

/** Panels mode: swayidle's screensaver timeout opens this fullscreen window; any input closes it. */
export function ScreensaverSurface() {
  return (
    <div className="relative h-full w-full">
      <Screensaver onDismiss={closeThisSurface} />
    </div>
  )
}
