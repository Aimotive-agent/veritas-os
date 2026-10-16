/*
 * Veritas Canvas's open documents in this window. Projects on disk are watched: a change made
 * elsewhere (Hermes, Compositor, another window) comes in as an undoable step, or as a question
 * when there are unsaved edits here. Saved projects save themselves shortly after each edit.
 */

import { atom } from 'nanostores'
import { isLayeredImage, isProjectPath, projectContaining } from '../../../shared/canvas/files.ts'
import type { CanvasProject } from '../../../shared/ipc.ts'
import type { CanvasDocument } from './engine/document.ts'
import {
  type Background,
  documentFromImage,
  type ExportKind,
  exportImage,
  newDocument,
  openProject,
  reloadProject,
  saveProject,
  watchProject
} from './engine/project.ts'
import { messageOf } from './errors.ts'
import { thumbnailOf } from './tools/screen.ts'

export const $documents = atom<CanvasDocument[]>([])
export const $activeKey = atom<string | null>(null)

/** A project changed on disk while it had unsaved edits here. */
export interface Conflict {
  key: string
  project: CanvasProject
}

export const $conflict = atom<Conflict | null>(null)

export interface Notice {
  message: string
  tone: 'info' | 'error'
  at: number
}

/** The last thing worth telling the person (shown briefly in the status bar). */
export const $notice = atom<Notice | null>(null)

export const notify = (message: string, tone: Notice['tone'] = 'info'): void => $notice.set({ message, tone, at: Date.now() })

/** List what an import or export approximated, in a dialog the person dismisses. */
export function showNotes(title: string, notes: string[]): void {
  if (notes.length) {
    void import('./menus.ts').then(({ $dialog }) => $dialog.set({ kind: 'notes', title, notes }))
  }
}

const AUTOSAVE_KEY = 'herald-canvas.autosave'
export const $autosave = atom<boolean>(globalThis.localStorage?.getItem(AUTOSAVE_KEY) !== 'off')

export function setAutosave(on: boolean): void {
  $autosave.set(on)
  globalThis.localStorage?.setItem(AUTOSAVE_KEY, on ? 'on' : 'off')

  if (on) {
    $documents.get().forEach(scheduleAutosave)
  }
}

const AUTOSAVE_DELAY = 1500

interface Tracked {
  unsubscribe: () => void
  unwatch: () => void
  timer: ReturnType<typeof setTimeout> | null
  saving: Promise<unknown> | null
}

const tracked = new Map<string, Tracked>()

export const activeDocument = (): CanvasDocument | null => $documents.get().find((doc) => doc.key === $activeKey.get()) ?? null

/** Tell main what is open here, so Hermes's commands know which image is in front. */
export function reportPresence(focused = false): void {
  window.heraldOS.canvas.report({
    focused,
    active: $activeKey.get(),
    documents: $documents.get().map((doc) => ({ key: doc.key, path: doc.path, name: doc.name, width: doc.state.width, height: doc.state.height, modified: doc.modified, layers: doc.state.layers.length }))
  })
}

export function activate(key: string): void {
  if ($documents.get().some((doc) => doc.key === key)) {
    $activeKey.set(key)
  }
}

const describe = messageOf

function watch(doc: CanvasDocument): () => void {
  return watchProject(doc, (project) => {
    if (!doc.modified) {
      reloadProject(doc, project).catch((error: unknown) => notify(`Could not take in the change to ${doc.name}: ${describe(error)}`, 'error'))
    } else {
      $conflict.set({ key: doc.key, project })
    }
  })
}

function scheduleAutosave(doc: CanvasDocument): void {
  const entry = tracked.get(doc.key)

  if (!entry || !doc.path || !doc.modified || !$autosave.get()) {
    return
  }

  if (entry.timer) {
    clearTimeout(entry.timer)
  }

  entry.timer = setTimeout(() => {
    entry.timer = null

    if (entry.saving) {
      void entry.saving.finally(() => scheduleAutosave(doc))

      return
    }

    // Mid-stroke or mid-transform the document shows a preview: save once it is settled.
    if (doc.interacting) {
      scheduleAutosave(doc)

      return
    }

    if (doc.modified && doc.path && $conflict.get()?.key !== doc.key) {
      void save(doc).catch(() => {})
    }
  }, AUTOSAVE_DELAY)
}

/** How long after a document opens its picture is taken for the History panel (the window has drawn it by then). */
const OPENING_THUMB_MS = 400

export function addDocument(doc: CanvasDocument): CanvasDocument {
  tracked.set(doc.key, {
    unsubscribe: doc.subscribe(() => scheduleAutosave(doc)),
    unwatch: watch(doc),
    timer: null,
    saving: null
  })
  $documents.set([...$documents.get(), doc])
  $activeKey.set(doc.key)
  setTimeout(() => {
    // Only the opening state itself: once something has changed, there is none to take.
    if (tracked.has(doc.key) && !doc.history.applied && !doc.history.canRedo && !doc.interacting) {
      try {
        doc.openingThumb = thumbnailOf(doc)
        doc.changed()
      } catch {
        // No picture, no harm: the panel shows the row without one.
      }
    }
  }, OPENING_THUMB_MS)

  return doc
}

/** Open a project (or a file inside one) or an image; an already open project comes to the front. */
export async function openPath(file: string): Promise<CanvasDocument> {
  const project = isProjectPath(file) ? file.replace(/[/\\]+$/, '') : projectContaining(file)
  const existing = $documents.get().find((doc) => doc.path && doc.path === (project ?? file))

  if (existing) {
    activate(existing.key)

    return existing
  }

  if (project) {
    return addDocument(await openProject(project))
  }

  // A Photoshop document opens with its layers; what could not be carried over is listed.
  if (isLayeredImage(file)) {
    const { documentFromPsd } = await import('./psd/psd.ts')
    const { doc, notes } = await documentFromPsd(file)
    addDocument(doc)
    showNotes(`Opened ${doc.name}`, notes)

    return doc
  }

  return addDocument(await documentFromImage(file))
}

export function createDocument(width: number, height: number, background: Background = 'white', resolution = 72): CanvasDocument {
  return addDocument(newDocument(width, height, background, resolution))
}

/** Save to the document's project (or `to`), asking where when it has none (or for Save As). */
export async function save(doc: CanvasDocument | null = activeDocument(), options: { as?: boolean; to?: string } = {}): Promise<boolean> {
  if (!doc) {
    return false
  }

  let file = options.to ?? doc.path

  if (!file || (options.as && !options.to)) {
    file = await window.heraldOS.canvas.pickSave('project', doc.name)

    if (!file) {
      return false
    }
  }

  const entry = tracked.get(doc.key)
  const before = doc.path
  const saving = saveProject(doc, file)

  if (entry) {
    entry.saving = saving
  }

  try {
    await saving
  } catch (error) {
    notify(`Could not save ${doc.name}: ${describe(error)}`, 'error')
    throw error
  } finally {
    if (entry) {
      entry.saving = null
    }
  }

  if (entry && doc.path !== before) {
    entry.unwatch()
    entry.unwatch = watch(doc)
  }

  return true
}

export async function exportDocument(doc: CanvasDocument | null, kind: ExportKind | 'psd', options: { quality?: number; scale?: number } = {}): Promise<string | null> {
  if (!doc) {
    return null
  }

  const file = await window.heraldOS.canvas.pickSave(kind, doc.name)

  if (!file) {
    return null
  }

  notify(`Exporting ${file.split('/').pop()}…`)

  try {
    if (kind === 'psd') {
      const { exportPsd } = await import('./psd/psd.ts')
      const { file: written, notes } = await exportPsd(doc.state, file)
      const name = written.split('/').pop() ?? written
      notify(`Exported ${name}`)
      showNotes(`Exported ${name}`, notes)

      return written
    }

    const written = await exportImage(doc.state, file, kind, options)
    notify(`Exported ${written.split('/').pop()}`)

    return written
  } catch (error) {
    notify(`Could not export: ${describe(error)}`, 'error')

    return null
  }
}

export function closeDocument(key: string): void {
  const entry = tracked.get(key)

  if (entry) {
    entry.unsubscribe()
    entry.unwatch()

    if (entry.timer) {
      clearTimeout(entry.timer)
    }

    tracked.delete(key)
  }

  const docs = $documents.get()
  const index = docs.findIndex((doc) => doc.key === key)
  const rest = docs.filter((doc) => doc.key !== key)
  $documents.set(rest)

  if ($activeKey.get() === key) {
    $activeKey.set(rest[Math.min(index, rest.length - 1)]?.key ?? null)
  }

  if ($conflict.get()?.key === key) {
    $conflict.set(null)
  }
}

/** Settle a conflict: take the version on disk (undoable), or keep the edits here (saved over it). */
export async function resolveConflict(choice: 'theirs' | 'mine'): Promise<void> {
  const conflict = $conflict.get()
  const doc = $documents.get().find((entry) => entry.key === conflict?.key)
  $conflict.set(null)

  if (!conflict || !doc) {
    return
  }

  if (choice === 'theirs') {
    await reloadProject(doc, conflict.project)
  } else {
    doc.digest = conflict.project.digest
    await save(doc)
  }
}
