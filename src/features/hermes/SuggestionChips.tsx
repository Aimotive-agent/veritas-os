import { IconArrowRight, IconList, IconListDetails, IconMessageQuestion, IconPresentation, IconSparkles } from '@tabler/icons-react'
import type React from 'react'

interface Chip {
  label: string
  icon: React.ReactNode
}

const WITH_ARTIFACT: Chip[] = [
  { label: 'Shorten it', icon: <IconSparkles size={15} stroke={1.7} /> },
  { label: 'Add milestones', icon: <IconList size={15} stroke={1.7} /> },
  { label: 'Create slides', icon: <IconPresentation size={15} stroke={1.7} /> }
]

const GENERIC: Chip[] = [
  { label: 'Explain more', icon: <IconMessageQuestion size={15} stroke={1.7} /> },
  { label: 'Give me next steps', icon: <IconArrowRight size={15} stroke={1.7} /> },
  { label: 'Summarize', icon: <IconListDetails size={15} stroke={1.7} /> }
]

/** Follow-up prompts after a finished turn; each chip sends its label as the next message. */
export function SuggestionChips({ hasArtifact, disabled, onPick }: { hasArtifact: boolean; disabled?: boolean; onPick: (text: string) => void }) {
  const chips = (hasArtifact ? WITH_ARTIFACT : GENERIC).slice(0, 3)

  return (
    <div className="stagger flex flex-wrap items-center gap-2">
      {chips.map(chip => (
        <button
          key={chip.label}
          type="button"
          disabled={disabled}
          onClick={() => onPick(chip.label)}
          className="flex h-8 items-center gap-2 rounded-full border border-line bg-white/6 px-3.5 text-[12.5px] text-fg-2 transition-colors duration-120 hover:border-line-strong hover:bg-white/10 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
        >
          <span className="text-fg-2">{chip.icon}</span>
          {chip.label}
        </button>
      ))}
    </div>
  )
}
