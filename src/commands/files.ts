import { isViewable } from '../../shared/viewer.ts'
import { fail, ok, type OsCommand } from '../store/os-commands.ts'
import { openFileWindow } from '../store/web-windows.ts'
import { showPage } from '../store/windows.ts'
import { $home, $location, $query, $selectedPath, askHermesToFind, basename, createFolder, currentDir, ensureHome, expandHome, navigate, refresh, revealItem } from '../features/files/files-store.ts'

/* The Files page: places, folders, search, a few mutations. Destructive file actions stay with Hermes's audited tools. */

const PLACES: Record<string, string> = {
  home: '~',
  'home folder': '~',
  downloads: '~/Downloads',
  desktop: '~/Desktop',
  documents: '~/Documents',
  pictures: '~/Pictures',
  photos: '~/Pictures',
  music: '~/Music',
  movies: '~/Movies',
  videos: '~/Movies',
  'applications folder': '/Applications',
  projects: '~/Apps'
}

export const PLACE_NAMES: readonly string[] = Object.keys(PLACES)

/** Turn "downloads", "~/Apps/x" or "/tmp" into an absolute path; null when it is not a place. */
export async function resolvePlace(input: string): Promise<{ path: string; label: string } | { kind: 'recent' | 'favorites' } | null> {
  const key = input.trim().toLowerCase().replace(/^(the|my)\s+/, '').replace(/\s+folder$/, '')

  if (key === 'recent' || key === 'recent files' || key === 'recents') {
    return { kind: 'recent' }
  }

  if (key === 'favorites' || key === 'favourites' || key === 'starred') {
    return { kind: 'favorites' }
  }

  const home = await ensureHome()
  const raw = PLACES[key] ?? (input.startsWith('/') || input.startsWith('~') ? input.trim() : null)

  if (!raw) {
    return null
  }

  const path = expandHome(raw, home) ?? raw

  return { path, label: PLACES[key] ? input.trim().replace(/^(the|my)\s+/i, '') : basename(path) }
}

/** Words that look like a file name: "hello.pdf", "hello dot pdf", "notes.md". */
const FILE_EXTENSION = /(?:\.|\s+dot\s+)([a-z0-9]{1,5})$/i

export function looksLikeFileName(text: string): boolean {
  return FILE_EXTENSION.test(text.trim())
}

/** "www.openhello.pdf" is a mis-heard file name, not a web address: known file extensions win. */
export function looksLikeFileNotUrl(text: string): boolean {
  const ext = FILE_EXTENSION.exec(text.trim())?.[1]

  return Boolean(ext && KNOWN_FILE_EXTENSIONS.has(ext.toLowerCase()))
}

const KNOWN_FILE_EXTENSIONS = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'key', 'pages', 'numbers', 'txt', 'md', 'csv', 'json', 'png', 'jpg', 'jpeg', 'gif', 'heic', 'webp', 'svg', 'mp4', 'mov', 'mp3', 'wav', 'm4a', 'zip', 'dmg', 'rtf', 'log', 'yaml', 'yml', 'ts', 'tsx', 'js', 'py', 'html', 'epub'])

/** The file a spoken name refers to: a path, or the best Spotlight match by name. */
async function findFile(name: string): Promise<{ path: string; candidates: string[] } | null> {
  const text = name.trim()

  if (text.startsWith('/') || text.startsWith('~')) {
    const home = await ensureHome()

    return { path: expandHome(text, home) ?? text, candidates: [] }
  }

  // Transcribers glue a stray "www." or "open" onto the name ("www.openhello.pdf").
  const query = text.replace(/^(?:https?:\/\/)?(?:www\.)/i, '').replace(/^open\s*/i, '')
  let matches = await window.heraldOS.fs.find(query, 8)

  if (matches.length === 0 && query !== text) {
    matches = await window.heraldOS.fs.find(text, 8)
  }

  const files = matches.filter(m => m.kind === 'file')

  return files.length ? { path: files[0].path, candidates: files.slice(1, 5).map(f => f.path) } : null
}

export const filesCommands: readonly OsCommand[] = [
  {
    id: 'file.open',
    title: 'Open a file',
    description: 'Find a file by name (or path) and open it inside Veritas OS: PDFs, images, text and media in a viewer window; other files are shown in Files.',
    tier: 'act',
    args: [{ name: 'name', type: 'string', description: 'File name as you remember it ("hello.pdf", "the budget spreadsheet") or a path', required: true }],
    phrases: ['open the file {name}', 'open file {name}', 'show the file {name}', 'open the document {name}', 'open the pdf {name}', 'open my {name} file', 'find and open {name}'],
    run: async ({ name }) => {
      const found = await findFile(String(name))

      if (!found) {
        showPage('files')
        $query.set(String(name).replace(/\s+dot\s+/gi, '.'))

        return fail(`No file named "${String(name)}" in your home folder.`, { spoken: `I could not find a file called ${String(name)}.` })
      }

      const fileName = basename(found.path)

      if (isViewable(found.path)) {
        const id = await openFileWindow(found.path)

        return ok(`Opened ${fileName}`, { spoken: `Opening ${fileName.replace(/\.[^.]+$/, '')}.`, highlight: { kind: 'window', id }, data: { path: found.path, others: found.candidates } })
      }

      // Not something the viewer shows: point at it in Files, still inside the OS.
      const parent = found.path.replace(/\/[^/]+$/, '') || '/'
      showPage('files')
      navigate({ kind: 'dir', path: parent })
      $selectedPath.set(found.path)

      return ok(`Showing ${fileName} in Files`, { spoken: `Here is ${fileName.replace(/\.[^.]+$/, '')}. Say "open it in its app" to open it outside Veritas OS.`, page: 'files', highlight: { kind: 'file', id: found.path }, data: { path: found.path } })
    }
  },
  {
    id: 'file.openExternal',
    title: 'Open a file in its app',
    description: 'Open the selected (or given) file with the Mac app that owns it (Pages, Excel, …). This leaves Veritas OS.',
    tier: 'act',
    args: [{ name: 'path', type: 'string', description: 'Path; omit for the selected file' }],
    phrases: ['open it in its app', 'open it outside', 'open it in the default app', 'open it externally'],
    run: async ({ path }) => {
      const target = path ? (expandHome(String(path), $home.get() ?? (await ensureHome())) ?? String(path)) : $selectedPath.get()

      if (!target) {
        return fail('Select a file in Files first.')
      }

      await window.heraldOS.fs.openPath(target)

      return ok(`Opened ${basename(target)} in its app`)
    }
  },
  {
    id: 'files.show',
    title: 'Show a file or folder in Files',
    description: 'Open the Files page at a folder, or at a file\'s folder with the file selected.',
    tier: 'read',
    args: [{ name: 'path', type: 'string', description: 'File or folder path', required: true }],
    hidden: true,
    run: async ({ path }) => {
      const home = await ensureHome()
      const target = expandHome(String(path), home) ?? String(path)
      const entries = await window.heraldOS.fs.readDir(target).then(
        () => true,
        () => false
      )
      showPage('files')

      if (entries) {
        navigate({ kind: 'dir', path: target })

        return ok(`Showing ${basename(target)}`, { page: 'files', data: { path: target } })
      }

      const parent = target.replace(/\/[^/]+$/, '') || '/'
      navigate({ kind: 'dir', path: parent })
      $selectedPath.set(target)

      return ok(`Showing ${basename(target)} in ${basename(parent)}`, { page: 'files', highlight: { kind: 'file', id: target }, data: { path: target } })
    }
  },
  {
    id: 'files.open',
    title: 'Open a folder',
    description: 'Open Files at a place (downloads, desktop, documents, home, recent, favorites) or a path.',
    tier: 'read',
    args: [{ name: 'place', type: 'string', description: 'Place name or absolute/~ path', required: true }],
    phrases: ['open my {place} folder', 'open the {place} folder', 'show my {place} folder', 'go to my {place} folder', 'show my recent files', 'open recent files'],
    run: async ({ place }) => {
      const target = await resolvePlace(String(place))

      if (!target) {
        return fail(`"${String(place)}" is not a folder I know. Try downloads, desktop, documents, or a path.`)
      }

      showPage('files')

      if ('kind' in target) {
        navigate({ kind: target.kind })

        return ok(`Showing ${target.kind} files`, { page: 'files' })
      }

      navigate({ kind: 'dir', path: target.path })

      return ok(`Opened ${target.label}`, { spoken: `Opening ${target.label}.`, page: 'files', highlight: { kind: 'file', id: target.path }, data: { path: target.path } })
    }
  },
  {
    id: 'files.search',
    title: 'Search files',
    description: 'Filter the current folder by name, or ask Hermes to find files described in words.',
    tier: 'read',
    args: [{ name: 'query', type: 'string', description: 'File name fragment or a description', required: true }],
    phrases: ['find files named {query}', 'search files for {query}', 'find {query} in my files', 'look for {query} in files'],
    run: async ({ query }) => {
      await ensureHome()
      showPage('files')
      const text = String(query)

      if (/\s/.test(text.trim()) && text.trim().split(/\s+/).length > 3) {
        // A sentence is a job for Hermes's Spotlight tool, not a filename filter.
        askHermesToFind(text)

        return ok(`Asked Hermes to find: ${text}`, { spoken: 'Asking Hermes to find that.' })
      }

      $query.set(text)

      return ok(`Filtering files by "${text}"`, { page: 'files', data: { folder: currentDir() } })
    }
  },
  {
    id: 'files.reveal',
    title: 'Reveal in file manager',
    description: 'Show the selected (or given) file in the system file manager.',
    tier: 'act',
    args: [{ name: 'path', type: 'string', description: 'Path; omit for the selected file' }],
    phrases: ['reveal in finder', 'show in finder', 'show this file in finder'],
    run: async ({ path }) => {
      const target = path ? (expandHome(String(path), $home.get() ?? (await ensureHome())) ?? String(path)) : $selectedPath.get()

      if (!target) {
        return fail('Nothing is selected in Files.')
      }

      revealItem(target)

      return ok(`Revealed ${basename(target)}`)
    }
  },
  {
    id: 'files.newFolder',
    title: 'New folder',
    description: 'Create a folder in the current Files location (or a given parent).',
    tier: 'mutate',
    args: [
      { name: 'name', type: 'string', description: 'Folder name', required: true },
      { name: 'in', type: 'string', description: 'Parent place or path; defaults to the open folder' }
    ],
    phrases: ['create a folder called {name}', 'new folder {name}', 'make a folder named {name}'],
    run: async ({ name, in: parent }) => {
      await ensureHome()
      let dir = currentDir()

      if (parent) {
        const target = await resolvePlace(String(parent))

        if (!target || 'kind' in target) {
          return fail(`"${String(parent)}" is not a folder I can create in.`)
        }

        dir = target.path
      }

      if (!dir) {
        return fail('Open a folder first, or say where to create it.')
      }

      showPage('files')
      navigate({ kind: 'dir', path: dir })
      const created = await createFolder(dir, String(name))

      if (!created) {
        return fail(`Could not create "${String(name)}" in ${basename(dir)}.`)
      }

      $selectedPath.set(created)

      return ok(`Created folder ${String(name)} in ${basename(dir)}`, { page: 'files', highlight: { kind: 'file', id: created }, data: { path: created } })
    }
  },
  {
    id: 'files.refresh',
    title: 'Refresh Files',
    description: 'Reload the current folder listing.',
    tier: 'read',
    args: [],
    hidden: true,
    run: () => {
      refresh()

      return ok('Refreshed', { data: { location: $location.get() } })
    }
  }
]
