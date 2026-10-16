import { atom } from 'nanostores'
import type { BrandingView } from '../../shared/branding.ts'

/** About's logo and name and the lock-screen picture, kept in step with main. */
export const $branding = atom<BrandingView>({ name: null, logo: null, lock: null })

let bound = false

export function bindBranding(): () => void {
  const bridge = window.heraldOS?.branding

  if (bound || !bridge) {
    return () => undefined
  }

  bound = true
  void bridge
    .get()
    .then(view => $branding.set(view))
    .catch(() => undefined)
  const off = bridge.onChanged(view => $branding.set(view))

  return () => {
    off()
    bound = false
  }
}
