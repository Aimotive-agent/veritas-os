import { cn } from '../lib/cn.ts'

/** The Hermes agent mark: a caduceus-inspired staff rendered as a single stroke. */
export function HermesMark({ className, size = 20 }: { className?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={cn('shrink-0 text-accent', className)} aria-hidden="true">
      <path d="M12 3v18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M6.5 8.5c0-2 2.2-3 5.5-3s5.5 1 5.5 3-2.2 3-5.5 3-5.5 1-5.5 3 2.2 3 5.5 3 5.5-1 5.5-3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="12" cy="3" r="1.4" fill="currentColor" />
    </svg>
  )
}
