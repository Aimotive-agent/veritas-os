import { memo, useEffect, useRef, useState } from 'react'
import { AppTile } from '../../components/app-icon.tsx'
import { cn } from '../../lib/cn.ts'
import type { LauncherTile } from './app-catalog.ts'

export const TILE_ICON = 68

/**
 * One launcher tile: a 68px icon area with a label underneath. Hermes apps render the blue glass
 * AppTile; native apps fetch their icon lazily once the tile scrolls into view, showing a neutral
 * placeholder until then and their initial if they have none. Keyboard focus stays in the search
 * field, so `active` is the roving ring.
 */
export const AppTileButton = memo(function AppTileButton({
  tile,
  index,
  active,
  iconFor,
  onActivate
}: {
  tile: LauncherTile
  index: number
  active: boolean
  iconFor: (path?: string) => string | undefined
  onActivate: (tile: LauncherTile) => void
}) {
  const ref = useRef<HTMLButtonElement>(null)
  const [inView, setInView] = useState(tile.kind !== 'native')

  useEffect(() => {
    const node = ref.current

    if (inView || !node) {
      return
    }

    if (typeof IntersectionObserver === 'undefined') {
      setInView(true)

      return
    }

    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          setInView(true)
          observer.disconnect()
        }
      },
      { rootMargin: '160px' }
    )
    observer.observe(node)

    return () => observer.disconnect()
  }, [inView])

  useEffect(() => {
    if (active) {
      ref.current?.scrollIntoView({ block: 'nearest' })
    }
  }, [active])

  const iconUrl = tile.kind === 'native' && inView ? iconFor(tile.app.path) : undefined

  return (
    <button
      ref={ref}
      type="button"
      tabIndex={-1}
      data-index={index}
      aria-label={`Open ${tile.label}`}
      onClick={() => onActivate(tile)}
      className={cn('group flex w-full flex-col items-center gap-2 rounded-xl px-1.5 pt-2.5 pb-2 transition-colors duration-150 hover:bg-white/6', active && 'bg-white/8 ring-2 ring-accent-strong/70')}
    >
      <span className="flex items-center justify-center transition-transform duration-150 group-active:scale-95" style={{ width: TILE_ICON, height: TILE_ICON }}>
        {tile.kind === 'hermes' ? (
          <AppTile id={tile.icon} size={TILE_ICON} />
        ) : iconUrl ? (
          <img src={iconUrl} alt="" width={TILE_ICON} height={TILE_ICON} draggable={false} loading="lazy" className="size-[68px] rounded-[18px] object-contain" />
        ) : iconUrl === '' ? (
          <span aria-hidden="true" className="icon-tile size-[68px] rounded-[18px] text-[28px] font-semibold">
            {(tile.label.trim()[0] ?? '?').toUpperCase()}
          </span>
        ) : (
          <span aria-hidden="true" className="size-[68px] rounded-[18px] bg-surface-2 hairline shimmer" />
        )}
      </span>
      <span className="w-full truncate text-center text-[12.5px] leading-tight text-fg-2 transition-colors group-hover:text-fg">{tile.label}</span>
    </button>
  )
})
