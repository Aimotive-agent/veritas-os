import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react'
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { GlassButton } from './ui/glass.tsx'

interface Props {
  /** Shown in the fallback so the user knows which surface broke. */
  label: string
  children: ReactNode
}

interface State {
  error: Error | null
}

/** Confines a render crash to one window or page so the rest of the desktop keeps working. */
export class SurfaceErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[herald-os] ${this.props.label} crashed`, error, info.componentStack)
  }

  render(): ReactNode {
    const { error } = this.state

    if (!error) {
      return this.props.children
    }

    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="glass-card flex max-w-md flex-col items-center gap-3 rounded-2xl px-6 py-7 text-center animate-pop">
          <span className="icon-tile size-11 rounded-xl text-amber-300">
            <IconAlertTriangle size={22} />
          </span>
          <div className="text-[15px] font-semibold">{this.props.label} ran into a problem</div>
          <div className="max-w-sm text-[12.5px] leading-relaxed text-fg-3 break-words">{error.message}</div>
          <GlassButton onClick={() => this.setState({ error: null })}>
            <IconRefresh size={14} />
            Try again
          </GlassButton>
        </div>
      </div>
    )
  }
}
