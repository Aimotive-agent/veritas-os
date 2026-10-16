import { atom, computed } from 'nanostores'
import type { WebViewEvent } from '../../shared/ipc.ts'
import { isWebUrl } from '../lib/web-url.ts'
import { $notificationsOpen } from './notifications.ts'
import { $pendingRequests } from './requests.ts'
import { isPanels } from './shell.ts'
import { $applicationsOpen, $commandBarOpen } from './surface.ts'
import { $windows, type Bounds, closeWindow, focusWindow, openApp, retitleWindow } from './windows.ts'

/*
 * Web pages inside Veritas OS. A web window is a native view main layers over the shell
 * (`window.heraldOS.web`), framed by a floating `web` Hermes window whose content rect it follows.
 * The shell never sends the user to the system browser for something it can host itself; the
 * provider sign-in is the first such page. Panels mode has no desktop window to layer over, so
 * there main opens a compositor window and no floating frame exists.
 */

export interface WebWindow {
  /** Main's view id (also the key). */
  id: string
  /** The floating Hermes window framing the view (desktop mode); null in panels mode. */
  windowId: string | null
  url: string
  title: string
  /** The opener pinned the title; page titles do not replace it. */
  fixedTitle: boolean
  loading: boolean
}

export interface OpenWebWindowOptions {
  title?: string
  /** Where the frame opens (desktop mode); defaults to the app's centred default size. */
  bounds?: Bounds
}

export const $webWindows = atom<Record<string, WebWindow>>({})

/**
 * Native views paint above every DOM layer, so while a shell overlay that must stay usable is up
 * (command bar, launcher, notifications panel, pending Hermes requests) the views hide and their
 * frames show a placeholder instead.
 */
export const $webViewsCovered = computed([$commandBarOpen, $applicationsOpen, $notificationsOpen, $pendingRequests], (command, apps, notifications, pending) => command || apps || notifications || pending.length > 0)

function patch(id: string, next: Partial<WebWindow>): void {
  const current = $webWindows.get()[id]

  if (current) {
    $webWindows.set({ ...$webWindows.get(), [id]: { ...current, ...next } })
  }
}

function remove(id: string): void {
  const next = { ...$webWindows.get() }
  delete next[id]
  $webWindows.set(next)
}

function onEvent(event: WebViewEvent): void {
  const entry = $webWindows.get()[event.id]

  if (!entry) {
    return
  }

  switch (event.type) {
    case 'title':
      patch(event.id, { title: entry.fixedTitle ? entry.title : event.title || entry.title })

      if (!entry.fixedTitle && entry.windowId) {
        retitleWindow(entry.windowId, event.title)
      }

      return
    case 'url':
      patch(event.id, { url: event.url })

      return
    case 'loading':
      patch(event.id, { loading: event.loading })

      return
    case 'closed':
      remove(event.id)

      if (entry.windowId) {
        closeWindow(entry.windowId)
      }

      return
    default:
      return
  }
}

let bound = false

function bind(): void {
  if (bound) {
    return
  }

  bound = true
  window.heraldOS.web.onEvent(onEvent)
  // The frame owns the page: once the window manager drops the frame, the view goes too.
  $windows.subscribe(windows => {
    for (const entry of Object.values($webWindows.get())) {
      if (entry.windowId && !windows[entry.windowId]) {
        remove(entry.id)
        void window.heraldOS.web.close(entry.id).catch(() => undefined)
      }
    }
  })
}

/** Open an http(s) page in a Veritas OS window; resolves with the web window id. */
export async function openWebWindow(url: string, options: OpenWebWindowOptions = {}): Promise<string> {
  if (!isWebUrl(url)) {
    throw new Error('Only http(s) pages can open in a Veritas OS window.')
  }

  bind()
  const id = await window.heraldOS.web.open(url, { title: options.title })
  const title = options.title ?? new URL(url).host
  const windowId = isPanels ? null : openApp('web', { payload: { viewId: id, url }, title, bounds: options.bounds, singleton: false })
  $webWindows.set({ ...$webWindows.get(), [id]: { id, windowId, url, title, fixedTitle: Boolean(options.title), loading: true } })

  return id
}

/** Show a local file (PDF, image, text, media) in a Veritas OS window; resolves with the view id. */
export async function openFileWindow(filePath: string, options: OpenWebWindowOptions = {}): Promise<string> {
  bind()
  const title = options.title ?? filePath.split('/').pop() ?? filePath
  const id = await window.heraldOS.web.openFile(filePath, { title })
  const url = `file://${filePath}`
  const windowId = isPanels ? null : openApp('web', { payload: { viewId: id, url }, title, bounds: options.bounds, singleton: false })
  $webWindows.set({ ...$webWindows.get(), [id]: { id, windowId, url, title, fixedTitle: true, loading: true } })

  return id
}

export function closeWebWindow(id: string): void {
  const entry = $webWindows.get()[id]

  if (!entry) {
    return
  }

  if (entry.windowId) {
    // The frame animates out; its removal closes the view (see `bind`).
    closeWindow(entry.windowId)
  } else {
    remove(id)
    void window.heraldOS.web.close(id).catch(() => undefined)
  }
}

/** Raise the frame (desktop mode); panels-mode windows are the compositor's to focus. */
export function focusWebWindow(id: string): void {
  const entry = $webWindows.get()[id]

  if (entry?.windowId) {
    focusWindow(entry.windowId)
  }
}
