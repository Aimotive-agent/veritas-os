import { useStore } from '@nanostores/react'
import { IconClock, IconDatabase, IconDimensions, IconExternalLink, IconFileDescription, IconMessage, IconStar, IconStarFilled, IconTarget, IconX } from '@tabler/icons-react'
import type React from 'react'
import { useEffect } from 'react'
import type { FilePreview } from '../../../shared/ipc.ts'
import { GlassButton, GlassCard, LinkAction } from '../../components/ui/glass.tsx'
import { cn } from '../../lib/cn.ts'
import { formatBytes } from '../../lib/format.ts'
import { useLocalData } from '../../lib/use-async.ts'
import { $prefs } from '../../store/backend.ts'
import { openStoredSession } from '../../store/chat.ts'
import { $allArtifacts, $missions } from '../../store/missions.ts'
import { notify } from '../../store/notifications.ts'
import { showPage } from '../../store/windows.ts'
import { FolderGlyph, Thumbnail } from './FileCard.tsx'
import { $home, type FileItem, askHermesAbout, describeType, expandHome, formatModified, isImage, itemCountLabel, messageOf, openItem, toggleFavorite, useDirCount, useThumbnail } from './files-store.ts'

function DetailRow({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 text-[12.5px] text-fg-2 [&_svg]:mt-px [&_svg]:size-[15px] [&_svg]:shrink-0 [&_svg]:text-fg-3">
      {icon}
      <span className="selectable min-w-0 break-words">{children}</span>
    </div>
  )
}

/** Right-hand panel for the selected item: preview, facts, related mission, actions. */
export function FileDetail({ item }: { item: FileItem }) {
  const home = useStore($home)
  const prefs = useStore($prefs)
  const artifacts = useStore($allArtifacts)
  const missions = useStore($missions)
  const favorite = prefs.favorites.includes(item.path)
  const image = isImage(item)
  const info = useLocalData(() => (image ? window.heraldOS.fs.imageInfo(item.path).catch(() => null) : Promise.resolve(null)), [item.path, image])
  const count = useDirCount(item.kind === 'directory' ? item.path : null)
  const artifact = artifacts.find(candidate => expandHome(candidate.path, home) === item.path)
  const mission = artifact ? missions.find(candidate => candidate.runtimeId === artifact.sessionId) : undefined

  const openMission = () => {
    if (!mission) {
      return
    }

    openStoredSession(mission.id)
      .then(() => showPage('hermes'))
      .catch(error => notify({ title: 'Could not open the mission', body: messageOf(error), level: 'error' }))
  }

  return (
    <GlassCard className="flex w-[230px] shrink-0 flex-col gap-3.5 overflow-y-auto p-3">
      <Thumbnail item={item} size={512} inView className="aspect-[16/10] w-full p-2" imgClassName="max-h-full" />

      <div className="flex items-start gap-1.5">
        <div className="selectable min-w-0 flex-1 text-[13.5px] leading-snug font-semibold break-words text-fg">{item.name}</div>
        <button
          type="button"
          aria-label={favorite ? 'Remove from Favorites' : 'Add to Favorites'}
          aria-pressed={favorite}
          onClick={() => toggleFavorite(item.path)}
          className={cn('flex size-7 shrink-0 items-center justify-center rounded-lg hover:bg-white/8', favorite ? 'text-warn' : 'text-fg-3 hover:text-fg')}
        >
          {favorite ? <IconStarFilled size={15} /> : <IconStar size={15} />}
        </button>
      </div>

      <div className="flex flex-col gap-2">
        <DetailRow icon={<IconFileDescription />}>{describeType(item)}</DetailRow>
        {image && (info.data ? <DetailRow icon={<IconDimensions />}>{`${info.data.width} × ${info.data.height}`}</DetailRow> : info.loading ? <div className="shimmer ml-[25px] h-3.5 w-20 rounded" /> : null)}
        <DetailRow icon={<IconDatabase />}>{item.kind === 'directory' ? itemCountLabel(count) : formatBytes(item.size)}</DetailRow>
        <DetailRow icon={<IconClock />}>{formatModified(item.modifiedAt, true)}</DetailRow>
      </div>

      {mission && (
        <div className="flex flex-col gap-1.5 border-t border-line pt-3">
          <div className="flex items-center gap-2.5 text-[12px] text-fg-3">
            <IconTarget size={15} className="shrink-0" />
            Related mission
          </div>
          <LinkAction onClick={openMission} className="ml-[25px] text-left">
            <span className="truncate">{mission.title}</span>
          </LinkAction>
        </div>
      )}

      <div className="flex flex-col gap-2 border-t border-line pt-3">
        <div className="text-[12.5px] font-medium text-fg">Actions</div>
        <GlassButton variant="primary" className="w-full" onClick={() => openItem(item)}>
          <IconExternalLink />
          Open
        </GlassButton>
        <GlassButton className="w-full" onClick={() => askHermesAbout(item.path)}>
          <IconMessage />
          Ask Hermes about this
        </GlassButton>
      </div>
    </GlassCard>
  )
}

/** Space-bar quick look, rendered inside the page. Images and text render inline; the rest explains itself. */
export function PreviewOverlay({ item, onClose }: { item: FileItem; onClose: () => void }) {
  const preview = useLocalData<FilePreview | null>(() => (item.kind === 'file' ? window.heraldOS.fs.readFile(item.path) : Promise.resolve(null)), [item.path])
  const large = useThumbnail(item.kind === 'file' && (preview.data?.kind === 'too-large' || preview.data?.kind === 'binary') ? item.path : null, 1024)

  useEffect(() => {
    if (preview.error) {
      notify({ title: `Could not preview "${item.name}"`, body: preview.error, level: 'error' })
    }
  }, [preview.error, item.name])

  return (
    <div className="absolute inset-0 z-40 flex flex-col p-4 animate-fade-in" role="dialog" aria-modal="true" aria-label={`Preview of ${item.name}`} onClick={onClose}>
      <div className="glass flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl animate-pop" onClick={event => event.stopPropagation()}>
        <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-line px-4">
          <div className="min-w-0">
            <div className="truncate text-[13.5px] font-semibold text-fg">{item.name}</div>
            <div className="truncate text-[11.5px] text-fg-3">
              {describeType(item)}
              {item.kind === 'file' && ` · ${formatBytes(item.size)}`}
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <GlassButton size="sm" onClick={() => openItem(item)}>
              <IconExternalLink />
              Open
            </GlassButton>
            <button type="button" aria-label="Close preview" onClick={onClose} className="flex size-8 items-center justify-center rounded-lg text-fg-3 hover:bg-white/8 hover:text-fg">
              <IconX size={16} />
            </button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
          {item.kind === 'directory' && (
            <div className="flex flex-col items-center gap-3 text-[12.5px] text-fg-3">
              <FolderGlyph size={120} />
              Press Enter to open this folder.
            </div>
          )}
          {item.kind === 'file' && preview.loading && !preview.data && <div className="shimmer h-full w-full rounded-xl" />}
          {preview.data?.kind === 'image' && preview.data.content && <img src={preview.data.content} alt={item.name} className="max-h-full max-w-full rounded-lg object-contain shadow-[0_20px_60px_rgba(0,8,50,.55)]" />}
          {preview.data?.kind === 'text' && (
            <pre className="selectable h-full w-full overflow-auto rounded-xl bg-black/25 p-4 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-fg-2 hairline">
              {preview.data.content}
              {preview.data.truncated && '\n… (truncated)'}
            </pre>
          )}
          {(preview.data?.kind === 'binary' || preview.data?.kind === 'too-large') &&
            (large.url ? (
              <img src={large.url} alt={item.name} className="max-h-full max-w-full rounded-lg object-contain shadow-[0_20px_60px_rgba(0,8,50,.55)]" />
            ) : large.loading ? (
              <div className="shimmer h-64 w-64 rounded-xl" />
            ) : (
              <div className="max-w-sm text-center text-[12.5px] text-fg-3">{preview.data.kind === 'too-large' ? 'Too large to preview here.' : 'No inline preview for this file.'} Open it in its app or ask Hermes about it.</div>
            ))}
          {preview.error && <div className="max-w-sm text-center text-[12.5px] text-fg-3">Preview unavailable.</div>}
        </div>
      </div>
    </div>
  )
}
