import { IconSparkles } from '@tabler/icons-react'
import { useState } from 'react'
import { GlassButton } from '../../../components/ui/glass.tsx'
import { Modal } from '../dialogs.tsx'
import type { CanvasDocument } from '../engine/document.ts'
import { $dialog } from '../menus.ts'
import { notify } from '../store.ts'
import { askHermes, prepareEdit, prepareGeneratedLayer, prepareGenerativeFill } from './hermes-ask.ts'

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Edit > Generative Fill and Layer > New Generated Layer: a few words for Hermes, who makes the picture with its image tool. */
export function GenerateDialog({ doc, mode }: { doc: CanvasDocument; mode: 'fill' | 'layer' }) {
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const close = () => $dialog.set(null)
  const fill = mode === 'fill'
  const ready = fill || prompt.trim().length > 0

  const submit = () => {
    if (!ready || busy) {
      return
    }

    setBusy(true)
    askHermes(fill ? prepareGenerativeFill(doc, prompt) : prepareGeneratedLayer(doc, prompt))
      .then(() => {
        notify(fill ? 'Asked Hermes to fill the selection' : 'Asked Hermes for a new layer')
        close()
      })
      .catch((error: unknown) => {
        notify(describe(error), 'error')
        setBusy(false)
      })
  }

  return (
    <Modal title={fill ? 'Generative Fill' : 'New Generated Layer'} onClose={close}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <textarea
          autoFocus
          rows={3}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submit()
            }
          }}
          aria-label={fill ? 'What goes in the selection' : 'What the new layer shows'}
          placeholder={fill ? 'What goes here? Leave it empty to carry on what is around it.' : 'Describe the picture, e.g. “a paper lantern glowing orange”'}
          className="glass-input w-full resize-none rounded-lg px-3 py-2.5 text-[13px] leading-relaxed outline-none placeholder:text-fg-4"
        />
        <p className="text-[11.5px] text-fg-3">
          Hermes makes it with its image generation tool and places it as a new layer{fill ? ', masked to the selection' : ''}. A picture of {fill ? 'the area' : 'nothing from the image'} is saved for it in /tmp. Some image services charge for each picture.
        </p>
        <div className="flex justify-end gap-2">
          <GlassButton type="button" variant="ghost" onClick={close}>
            Cancel
          </GlassButton>
          <GlassButton type="submit" variant="primary" disabled={!ready || busy}>
            <IconSparkles size={14} /> Ask Hermes
          </GlassButton>
        </div>
      </form>
    </Modal>
  )
}

/** The status bar's request line: an edit in words ("make it moodier"), which Hermes plans and makes with the canvas tool. */
export function AskHermesField({ doc }: { doc: CanvasDocument }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = () => {
    const request = text.trim()

    if (!request || busy) {
      return
    }

    setBusy(true)
    askHermes(prepareEdit(doc, request))
      .then(() => {
        setText('')
        notify('Asked Hermes; it edits the image with the canvas tool')
      })
      .catch((error: unknown) => notify(describe(error), 'error'))
      .finally(() => setBusy(false))
  }

  return (
    <form
      className="flex min-w-0 items-center gap-1.5"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <IconSparkles size={13} className="shrink-0 text-fg-3" />
      <input
        value={text}
        disabled={busy}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation()

          if (event.key === 'Escape') {
            setText('')
            event.currentTarget.blur()
          }
        }}
        aria-label="Ask Hermes to edit the image"
        placeholder="Ask Hermes to edit… (make it moodier, put the logo bottom right)"
        className="glass-input h-5 w-80 min-w-0 rounded-md px-2 text-[11.5px] text-fg outline-none placeholder:text-fg-4"
      />
    </form>
  )
}
