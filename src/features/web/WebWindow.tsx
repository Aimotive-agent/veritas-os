import { useStore } from '@nanostores/react'
import { IconFile, IconLock, IconPhotoEdit, IconWorld } from '@tabler/icons-react'
import { useMemo, useRef } from 'react'
import { isCanvasImage } from '../../../shared/canvas/files.ts'
import { Spinner } from '../../components/ui/primitives.tsx'
import { cn } from '../../lib/cn.ts'
import { describeWebUrl } from '../../lib/web-url.ts'
import { $webWindows } from '../../store/web-windows.ts'
import type { OSWindow } from '../../store/windows.ts'
import { openInCanvas } from '../canvas/open.ts'
import { useNativeView } from './native-view.ts'

/**
 * The frame of a web window: a read-only URL bar and an empty content area whose rect the native
 * view (owned by main) is placed over. The view shows only while the frame is fully open and nothing
 * the user needs sits above it; otherwise the area explains why the page is hidden.
 */
export function WebWindow({ win }: { win: OSWindow }) {
  const viewId = typeof win.payload?.viewId === 'string' ? win.payload.viewId : null
  const webWindows = useStore($webWindows)
  const entry = viewId ? webWindows[viewId] : undefined
  const content = useRef<HTMLDivElement>(null)
  const { visible, covered, occluded } = useNativeView(viewId, content, win, { active: Boolean(entry) })

  const url = entry?.url ?? (typeof win.payload?.url === 'string' ? win.payload.url : '')
  const parts = useMemo(() => describeWebUrl(url), [url])
  // Local files (the viewer) show their folder quietly and the file name in full.
  const filePath = url.startsWith('file://') ? decodeURIComponent(url.slice('file://'.length)) : null
  const fileDir = filePath ? filePath.replace(/[^/]+$/, '') : ''
  const fileName = filePath ? filePath.slice(fileDir.length) : ''

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <div className="glass-input flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-[11.5px]" aria-label={filePath ? 'File' : 'Page address'} title={filePath ?? url}>
          {filePath ? <IconFile size={12} className="shrink-0 text-fg-3" /> : parts?.secure ? <IconLock size={12} className="shrink-0 text-ok" aria-label="Secure connection" /> : <IconWorld size={12} className="shrink-0 text-fg-3" />}
          {filePath ? (
            <span className="truncate">
              <span className="text-fg-3">{fileDir}</span>
              <span className="text-fg">{fileName}</span>
            </span>
          ) : (
            <span className="truncate">
              <span className="text-fg">{parts?.host ?? url}</span>
              {parts?.rest && <span className="text-fg-3">{parts.rest}</span>}
            </span>
          )}
          {entry?.loading && <Spinner className="ml-auto shrink-0" />}
        </div>
        {filePath && isCanvasImage(filePath) && (
          <button
            type="button"
            onClick={() => openInCanvas(filePath)}
            className="flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-[11.5px] text-fg-2 hover:bg-white/8 hover:text-fg"
            title="Edit in Veritas Canvas"
          >
            <IconPhotoEdit size={13} /> Edit
          </button>
        )}
      </div>
      <div ref={content} className="relative min-h-0 flex-1 bg-black/20">
        {!visible && (
          <div className={cn('absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center text-[12.5px] text-fg-3', win.phase === 'open' && !entry && 'text-fg-2')}>
            <IconWorld size={26} className="text-fg-4" />
            <span>{!entry ? 'This page is no longer open.' : covered ? 'The page is hidden while a Hermes panel is open.' : occluded ? 'Bring this window forward to see the page.' : 'Opening…'}</span>
          </div>
        )}
      </div>
    </div>
  )
}
