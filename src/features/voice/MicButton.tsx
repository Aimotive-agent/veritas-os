import { useStore } from '@nanostores/react'
import { IconMicrophone } from '@tabler/icons-react'
import { cn } from '../../lib/cn.ts'
import { isMainSurface, relayToMain } from '../../store/shell.ts'
import { $voiceActive, toggleVoice } from '../../store/voice.ts'

/** The composers' microphone: starts (or ends) a spoken conversation with Hermes. */
export function MicButton({ size = 17, className, disabled }: { size?: number; className?: string; disabled?: boolean }) {
  const active = useStore($voiceActive)
  const label = active ? 'End voice conversation' : 'Talk to Hermes'
  const onClick = () => {
    if (isMainSurface) {
      void toggleVoice('button')
    } else {
      // Overlay windows (panels mode) hand the conversation to the Hermes window.
      relayToMain({ type: 'voice', args: ['toggle'] })
    }
  }

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex shrink-0 items-center justify-center rounded-lg transition-colors duration-120 disabled:cursor-not-allowed disabled:opacity-40',
        active ? 'bg-accent-soft text-accent-strong' : 'text-fg-2 hover:bg-white/8 hover:text-fg',
        className
      )}
    >
      <IconMicrophone size={size} stroke={1.7} />
    </button>
  )
}
