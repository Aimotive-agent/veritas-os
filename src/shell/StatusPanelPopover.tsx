import { useStore } from '@nanostores/react'
import { useEffect } from 'react'
import { StatusPanel } from '../features/status/StatusPanel.tsx'
import { $statusPanel } from '../store/status-panel.ts'

/** Desktop mode: the quick panel hangs under the menu bar on the right, like the notifications panel. */
export function StatusPanelPopover() {
  const panel = useStore($statusPanel)

  useEffect(() => {
    if (!panel) {
      return
    }

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        $statusPanel.set(null)
      }
    }
    window.addEventListener('keydown', onKey)

    return () => window.removeEventListener('keydown', onKey)
  }, [panel])

  if (!panel) {
    return null
  }

  const close = () => $statusPanel.set(null)

  return (
    <>
      <button type="button" aria-label="Close panel" className="absolute inset-0 z-(--z-panel)" onClick={close} />
      <div className="absolute top-10 right-3 z-(--z-overlay) w-[360px]">
        <StatusPanel key={panel} panel={panel} onClose={close} />
      </div>
    </>
  )
}
