import { useStore } from '@nanostores/react'
import { useEffect } from 'react'
import { $askDraft } from '../store/surface.ts'
import { AskPanel } from './surfaces/CommandSurface.tsx'

/** Desktop mode: "Ask Hermes" about a screen region (or any attached files), centred over the desktop. */
export function AskOverlay() {
  const draft = useStore($askDraft)

  useEffect(() => {
    if (!draft) {
      return
    }

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        $askDraft.set(null)
      }
    }
    window.addEventListener('keydown', onKey)

    return () => window.removeEventListener('keydown', onKey)
  }, [draft])

  if (!draft) {
    return null
  }

  const close = () => $askDraft.set(null)

  return (
    <>
      <button type="button" aria-label="Close" className="absolute inset-0 z-(--z-command) bg-black/20" onClick={close} />
      <div className="absolute top-[18%] left-1/2 z-(--z-command) w-[min(680px,92vw)] -translate-x-1/2">
        <AskPanel state={{ text: draft.text, context: null, attachments: draft.attachments }} onClose={close} />
      </div>
    </>
  )
}
