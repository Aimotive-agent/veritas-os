import { useEffect, useState } from 'react'
import { HeraldLogo } from '../../components/herald-logo.tsx'
import { Wallpaper } from '../../shell/Wallpaper.tsx'

/** Input in the first moment after it appears is the tail of whatever the person was doing. */
const GRACE_MS = 1200

/** The living wallpaper with a large clock; the first key, click or pointer move ends it. */
export function Screensaver({ onDismiss }: { onDismiss: () => void }) {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 10_000)
    const shownAt = Date.now()
    const dismiss = () => {
      if (Date.now() - shownAt > GRACE_MS) {
        onDismiss()
      }
    }
    const events = ['keydown', 'pointerdown', 'pointermove', 'wheel'] as const

    for (const name of events) {
      window.addEventListener(name, dismiss, { capture: true })
    }

    return () => {
      clearInterval(timer)

      for (const name of events) {
        window.removeEventListener(name, dismiss, { capture: true })
      }
    }
  }, [onDismiss])

  return (
    <div className="absolute inset-0 z-(--z-boot) cursor-none overflow-hidden bg-bg" role="presentation">
      <Wallpaper />
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-fg">
        <span className="text-[96px] leading-none font-semibold tabular-nums tracking-tight text-shadow-soft">{now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
        <span className="text-[20px] text-fg-2 text-shadow-soft">{now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</span>
      </div>
      <div className="absolute bottom-10 left-1/2 -translate-x-1/2 opacity-70">
        <HeraldLogo height={28} />
      </div>
    </div>
  )
}
