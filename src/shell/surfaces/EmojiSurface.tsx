import { useEffect, useState } from 'react'
import { EmojiPicker } from '../../features/emoji/EmojiPicker.tsx'
import { insertEmoji } from '../../store/emoji.ts'
import { closeThisSurface, onShellCommand } from '../../store/shell.ts'

/** macOS: the emoji panel over any app (Cmd+Ctrl+E). A pick is pasted into the app underneath. */
export function EmojiSurface() {
  // Each opening starts a fresh search.
  const [opening, setOpening] = useState(0)

  useEffect(() => onShellCommand(command => command.type === 'emoji' && setOpening(n => n + 1)), [])

  return (
    <div className="flex h-screen w-screen items-start justify-center bg-transparent p-2">
      <EmojiPicker key={opening} className="w-full" onPick={char => void insertEmoji(char)} onClose={closeThisSurface} />
    </div>
  )
}
