// Imported (not a public URL) so Vite rewrites it relative to `base` for the packaged `file://` renderer.
const heraldMarkUrl = new URL('brand/herald-mark.png', document.baseURI).href
import { cn } from '../lib/cn.ts'

/** The Veritas winged H, shared with the Veritas mobile app. White on transparency; sized by height. */
export function HeraldLogo({ height = 14, className }: { height?: number; className?: string }) {
  return <img src={heraldMarkUrl} alt="Veritas OS" height={height} style={{ height, width: 'auto' }} draggable={false} className={cn('shrink-0 select-none', className)} />
}
