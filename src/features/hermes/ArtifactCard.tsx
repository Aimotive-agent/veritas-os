import { IconChevronRight, IconFileText, IconPhoto } from '@tabler/icons-react'
import { memo } from 'react'
import { cn } from '../../lib/cn.ts'
import { formatBytes } from '../../lib/format.ts'
import { useLocalData } from '../../lib/use-async.ts'
import type { Artifact } from '../../store/missions.ts'
import { artifactKind, isEditable } from './artifact-store.ts'

/** A file Hermes produced in this turn; selecting it opens it in the artifact pane. */
export const ArtifactCard = memo(function ArtifactCard({ artifact, selected, onSelect }: { artifact: Artifact; selected: boolean; onSelect: () => void }) {
  const size = useLocalData(() => window.heraldOS.fs.readFile(artifact.path).then(file => file.size), [artifact.path, artifact.ts])
  const kind = artifactKind(artifact.name)
  const title = artifact.name.replace(/\.[a-z0-9]{1,6}$/i, '').replace(/[-_]+/g, ' ')
  const status = size.error ? 'Missing on disk' : isEditable(artifact.name) ? 'Ready to edit' : kind === 'image' ? 'Image' : 'Ready to open'

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={`Open ${artifact.name}`}
      className={cn('glass-card glass-card-hover flex w-full items-center gap-3.5 rounded-xl px-3.5 py-3 text-left', selected && 'glass-card-selected')}
    >
      <span className="icon-tile shrink-0" style={{ width: 40, height: 40, borderRadius: 10 }}>
        {kind === 'image' ? <IconPhoto size={20} stroke={1.6} /> : <IconFileText size={20} stroke={1.6} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-semibold text-fg">{title || artifact.name}</span>
        <span className={cn('block text-[12px]', size.error ? 'text-warn' : 'text-fg-3')}>{status}</span>
      </span>
      {size.loading ? <span className="shimmer h-3 w-10 rounded-sm" /> : size.data != null && <span className="text-[11.5px] tabular-nums text-fg-3">{formatBytes(size.data)}</span>}
      <IconChevronRight size={16} className="shrink-0 text-fg-3" />
    </button>
  )
})
