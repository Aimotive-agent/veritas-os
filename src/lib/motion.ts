/** Named durations and easings; components read these instead of inventing values. */
export const motion = {
  fast: 120,
  base: 180,
  slow: 320,
  ease: 'cubic-bezier(0.2, 0.7, 0.2, 1)'
} as const

export function reducedMotion(): boolean {
  return document.documentElement.dataset.reduceMotion === 'true' || window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Run `fn` after an exit animation, or immediately when motion is reduced. */
export function afterExit(fn: () => void, ms: number = motion.base): void {
  if (reducedMotion()) {
    fn()

    return
  }

  window.setTimeout(fn, ms)
}
