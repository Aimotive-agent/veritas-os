import { useStore } from '@nanostores/react'
import { useEffect, useRef } from 'react'
import type { PluginMethod, PluginPlacement, PluginView } from '../../../shared/plugins.ts'
import { cn } from '../../lib/cn.ts'
import { $prefs } from '../../store/backend.ts'

const METHODS = new Set<PluginMethod>(['stats', 'notify', 'storage.get', 'storage.set', 'run', 'theme'])
/** Calls a frame may make per second before it is ignored for the rest of that second. */
const RATE = 20
const THEME_VARS: Record<string, string> = {
  bg: '--color-bg',
  surface: '--color-surface',
  fg: '--color-fg',
  fg_dim: '--color-fg-3',
  accent: '--color-accent',
  accent_strong: '--color-accent-strong',
  line: '--color-line',
  ok: '--color-ok',
  warn: '--color-warn',
  urgent: '--color-danger'
}

function themeColors(): Record<string, string> {
  const style = getComputedStyle(document.documentElement)

  return Object.fromEntries(Object.entries(THEME_VARS).map(([key, variable]) => [key, style.getPropertyValue(variable).trim()]))
}

/**
 * One widget in a sandboxed frame: scripts only, no same-origin (so no access to the shell, its
 * storage or cookies), served by main under the plugin's CSP. Its messages are answered through
 * main, which checks the manifest's permissions; the theme is pushed so it can match the shell.
 */
export function PluginFrame({ plugin, at, className, title, width, height }: { plugin: PluginView; at: PluginPlacement; className?: string; title?: string; width?: number; height?: number }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const prefs = useStore($prefs)
  const id = plugin.manifest.id

  useEffect(() => {
    let windowStart = 0
    let count = 0

    const reply = (message: Record<string, unknown>) => frame.current?.contentWindow?.postMessage({ herald: 1, ...message }, '*')
    const pushTheme = () => reply({ event: 'theme', colors: themeColors(), scheme: document.documentElement.dataset.scheme ?? 'dark' })

    const onMessage = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow) {
        return
      }

      const message = event.data as { herald?: number; id?: number; method?: PluginMethod; params?: Record<string, unknown>; ready?: boolean }

      if (!message || message.herald !== 1) {
        return
      }

      if (message.ready) {
        pushTheme()

        return
      }

      const now = Date.now()

      if (now - windowStart > 1000) {
        windowStart = now
        count = 0
      }

      if (++count > RATE || typeof message.id !== 'number' || !message.method || !METHODS.has(message.method)) {
        return
      }

      void window.heraldOS.plugins
        .call(id, message.method, message.params ?? {})
        .then(result => reply({ reply: message.id, result }))
        .catch((error: unknown) => reply({ reply: message.id, error: error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error) }))
    }

    window.addEventListener('message', onMessage)

    return () => window.removeEventListener('message', onMessage)
  }, [id])

  // The palette changed: tell the widget.
  useEffect(() => {
    frame.current?.contentWindow?.postMessage({ herald: 1, event: 'theme', colors: themeColors(), scheme: document.documentElement.dataset.scheme ?? 'dark' }, '*')
  }, [prefs.themeColors, prefs.themeScheme, prefs.theme, prefs.accent])

  // Chromium paints a frame opaque when its colour scheme differs from the page around it, so the
  // frame and the widget's page (through the SDK) are given the same one.
  const scheme = document.documentElement.dataset.scheme === 'light' ? 'light' : 'dark'

  return (
    <iframe
      ref={frame}
      // `at` tells the widget where it sits (herald.placement); the revision changes when its files
      // are saved, so the frame reloads.
      src={`herald-plugin://${id}/${plugin.manifest.entry}?at=${at}&scheme=${scheme}&rev=${plugin.revision}`}
      sandbox="allow-scripts"
      title={title ?? plugin.manifest.name}
      className={cn('block border-0 bg-transparent', className)}
      style={{ width, height, colorScheme: scheme }}
      // A widget never gets the camera, the microphone or the clipboard.
      allow=""
    />
  )
}
