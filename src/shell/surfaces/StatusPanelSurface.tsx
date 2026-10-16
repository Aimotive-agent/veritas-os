import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ShellCommand, StatusPanelId } from '../../../shared/ipc.ts'
import { StatusPanel } from '../../features/status/StatusPanel.tsx'
import { closeThisSurface } from '../../store/shell.ts'
import { useShellCommands } from './shell-utils.ts'

const PANELS = new Set<StatusPanelId>(['wifi', 'bluetooth', 'audio', 'display', 'power', 'clock'])
const WIDTH = 380
const MAX_HEIGHT = 560

/** Panels mode: a menu-bar quick panel in its own transparent window, under the bar at the top right. */
export function StatusPanelSurface() {
  const [panel, setPanel] = useState<StatusPanelId | null>(null)
  const box = useRef<HTMLDivElement>(null)

  useShellCommands((command: ShellCommand) => {
    const next = command.args?.[0] as StatusPanelId | undefined

    if (command.type === 'panel' && next && PANELS.has(next)) {
      setPanel(next)
    }
  })

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeThisSurface()
      }
    }
    window.addEventListener('keydown', onKey)

    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // The window hugs the panel so clicks beside it reach whatever is underneath.
  useLayoutEffect(() => {
    const node = box.current

    if (!node || typeof ResizeObserver === 'undefined') {
      return
    }

    let last = 0
    const fit = () => {
      const height = Math.min(MAX_HEIGHT, Math.ceil(node.getBoundingClientRect().height) + 4)

      if (height > 0 && height !== last) {
        last = height
        window.heraldOS.shell.resize(WIDTH, height).catch(() => undefined)
      }
    }
    const observer = new ResizeObserver(fit)
    observer.observe(node)
    fit()

    return () => observer.disconnect()
  }, [panel])

  return (
    <div className="flex h-full w-full items-start justify-center overflow-hidden text-fg">
      <div ref={box} className="w-full">
        {panel && <StatusPanel key={panel} panel={panel} onClose={closeThisSurface} />}
      </div>
    </div>
  )
}
