import { useStore } from '@nanostores/react'
import { IconCopy, IconEyeOff, IconFolder, IconFolderOpen, IconExternalLink, IconAppWindow } from '@tabler/icons-react'
import { useState } from 'react'
import type { RecentFile } from '../../../shared/ipc.ts'
import { isViewable } from '../../../shared/viewer.ts'
import { GlassCard, LinkAction, MoreButton, Section } from '../../components/ui/glass.tsx'
import { formatRelative } from '../../lib/format.ts'
import { useLocalData } from '../../lib/use-async.ts'
import { $prefs } from '../../store/backend.ts'
import { notify } from '../../store/notifications.ts'
import { runCommand } from '../../store/os-commands.ts'
import { showPage } from '../../store/windows.ts'
import { copyPath, fromRecent, loadRecents, openItem, removeFromRecents } from '../files/files-store.ts'
import { Menu, type MenuItemDef } from '../files/Menu.tsx'
import { FileThumb, IconTile, Shimmer } from './shared.tsx'

const SHOWN = 4

/** Open inside Veritas OS: folders in Files, PDFs/images/text/media in the viewer, the rest in their app. */
function openRecent(file: RecentFile): void {
  if (file.kind === 'directory') {
    showPage('files')
  }

  openItem(fromRecent(file))
}

function menuFor(file: RecentFile, onRemove: () => void): MenuItemDef[] {
  const items: MenuItemDef[] = [{ id: 'open', label: 'Open', icon: <IconAppWindow />, onSelect: () => openRecent(file) }]

  if (file.kind === 'file' && isViewable(file.path)) {
    items.push({ id: 'open-app', label: 'Open in its app', icon: <IconExternalLink />, onSelect: () => void window.heraldOS.fs.openPath(file.path).catch(error => notify({ title: `Could not open "${file.name}"`, body: String(error), level: 'error' })) })
  }

  items.push(
    { id: 'show', label: 'Show in Files', icon: <IconFolderOpen />, onSelect: () => void runCommand('files.show', { path: file.path }, { source: 'ui' }) },
    { id: 'copy', label: 'Copy path', icon: <IconCopy />, onSelect: () => copyPath(file.path) },
    { id: 'remove', label: 'Remove from Recents', icon: <IconEyeOff />, onSelect: onRemove, dividerBefore: true }
  )

  return items
}

/** The last few files touched on this Mac, as thumbnail cards; the menu opens, shows or hides each one. */
export function RecentWork() {
  const hidden = useStore($prefs).hiddenRecents
  const recent = useLocalData(() => loadRecents(SHOWN), [hidden?.length ?? 0])
  const [menuFor_, setMenuFor] = useState<string | null>(null)
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set())
  const files = (recent.data ?? []).filter(file => !removed.has(file.path)).slice(0, SHOWN)

  const remove = (file: RecentFile) => {
    setRemoved(new Set([...removed, file.path]))
    removeFromRecents(file.path).catch(error => notify({ title: 'Could not remove from Recents', body: String(error), level: 'error' }))
  }

  return (
    <Section title="Recent work" action={<LinkAction onClick={() => showPage('files')}>See all</LinkAction>}>
      {recent.loading && !recent.data ? (
        <div className="grid grid-cols-2 gap-3">
          {Array.from({ length: SHOWN }, (_, i) => (
            <Shimmer key={i} className="h-[76px] rounded-xl" />
          ))}
        </div>
      ) : files.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line px-4 py-5 text-center text-[12.5px] text-fg-3">{recent.error ? 'Recent files are unavailable right now.' : 'Nothing recent yet. Files you work on will show up here.'}</div>
      ) : (
        <div className="stagger grid grid-cols-2 gap-3">
          {files.map(file => {
            const kind = file.kind === 'directory' ? 'Folder' : file.extension ? file.extension.replace(/^\./, '').toUpperCase() : 'File'
            const edited = formatRelative(file.modifiedAt)
            const open = menuFor_ === file.path

            return (
              <div key={file.path} className={open ? 'relative z-20' : 'relative'}>
                <GlassCard interactive onClick={() => openRecent(file)} className="flex items-center gap-3 p-2.5">
                  {file.kind === 'directory' ? (
                    <IconTile size={56} className="rounded-lg">
                      <IconFolder />
                    </IconTile>
                  ) : (
                    <FileThumb path={file.path} size={256} className="h-[56px] w-[84px] shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-fg" title={file.path}>
                      {file.name}
                    </div>
                    <div className="truncate text-[11.5px] text-fg-3">
                      {kind}
                      {edited ? ` · Edited ${edited}` : ''}
                    </div>
                  </div>
                  <MoreButton
                    aria-label={`More actions for ${file.name}`}
                    aria-expanded={open}
                    onClick={event => {
                      event.stopPropagation()
                      setMenuFor(open ? null : file.path)
                    }}
                  />
                </GlassCard>
                {open && <Menu items={menuFor(file, () => remove(file))} onClose={() => setMenuFor(null)} className="top-12" />}
              </div>
            )
          })}
        </div>
      )}
    </Section>
  )
}
