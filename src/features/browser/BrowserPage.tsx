import { useStore } from '@nanostores/react'
import { IconArrowLeft, IconArrowRight, IconBrandChrome, IconExternalLink, IconLock, IconRefresh, IconWorld } from '@tabler/icons-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { BrowserOsInfo, BrowserTab } from '../../../shared/ipc.ts'
import { GlassButton, PageHeader, Pill } from '../../components/ui/glass.tsx'
import { notify } from '../../store/notifications.ts'
import { cn } from '../../lib/cn.ts'

/**
 * The shell's browser. A real Chromium view lives inline here (via the same native-view layer the
 * agent pages use), and BrowserOS — the user's own AI browser — is one click away for anything that
 * should live in the browser they actually use.
 */
function normalize(input: string): string {
  const value = input.trim()

  if (!value) {
    return ''
  }
  if (/^https?:\/\//i.test(value)) {
    return value
  }
  // A bare word becomes a search; anything with a dot looks like a host.
  return /\.[a-z]{2,}/i.test(value.split(/[/?#]/)[0] ?? '') ? `https://${value}` : `https://duckduckgo.com/?q=${encodeURIComponent(value)}`
}

export function BrowserPage({ active = true }: { active?: boolean }) {
  const [address, setAddress] = useState('https://www.google.com')
  const [url, setUrl] = useState<string | null>(null)
  const [viewId, setViewId] = useState<string | null>(null)
  const [browser, setBrowser] = useState<BrowserOsInfo | null>(null)
  const [tabs, setTabs] = useState<BrowserTab[]>([])
  const [loading, setLoading] = useState(false)
  const content = useRef<HTMLDivElement>(null)

  const refreshBrowser = () => {
    void window.heraldOS.browser.status().then(setBrowser).catch(() => undefined)
    void window.heraldOS.browser.tabs().then(setTabs).catch(() => undefined)
  }

  useEffect(() => {
    refreshBrowser()
    const interval = setInterval(refreshBrowser, 6000)

    return () => clearInterval(interval)
  }, [])

  // One embedded view per page; navigating reloads it in place.
  useLayoutEffect(() => {
    if (!url) {
      return
    }

    let alive = true
    void window.heraldOS.web
      .open(url, { title: 'Browser' })
      .then(id => {
        if (alive) {
          setViewId(id)
          setLoading(true)
        } else {
          void window.heraldOS.web.close(id)
        }
      })
      .catch(error => notify({ title: 'Could not open the page', body: String(error?.message ?? error), level: 'error' }))

    return () => {
      alive = false
    }
  }, [url])

  // Keep the native view over this page's content area; hide it whenever another page is active.
  useLayoutEffect(() => {
    if (!viewId) {
      return
    }

    const node = content.current

    if (!node) {
      return
    }

    let frame = 0
    const report = () => {
      const rect = node.getBoundingClientRect()
      const show = active && rect.width >= 60 && rect.height >= 60
      window.heraldOS.web.setBounds(viewId, { x: rect.left, y: rect.top, width: rect.width, height: rect.height, radius: 0 }, show)
    }

    report()
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(report)
    })
    observer.observe(node)
    window.addEventListener('resize', report)
    const interval = setInterval(report, 600)

    return () => {
      cancelAnimationFrame(frame)
      clearInterval(interval)
      observer.disconnect()
      window.removeEventListener('resize', report)
      window.heraldOS.web.setBounds(viewId, { x: 0, y: 0, width: 1, height: 1, radius: 0 }, false)
    }
  }, [viewId, active])

  useEffect(() => {
    const off = window.heraldOS.web.onEvent(event => {
      if (viewId && event.id === viewId && event.type === 'loading') {
        setLoading(Boolean(event.loading))
      }
    })

    return off
  }, [viewId])

  const go = (input: string) => {
    const next = normalize(input)

    if (!next) {
      return
    }
    setAddress(next)

    if (next === url && viewId) {
      void window.heraldOS.web.reload(viewId).catch(() => undefined)
      return
    }
    setUrl(next)
  }

  const openInBrowserOs = async () => {
    const next = normalize(address)

    if (!next) {
      return
    }
    try {
      await window.heraldOS.browser.open(next)
      notify({ title: 'Opened in BrowserOS', body: next, level: 'success' })
      refreshBrowser()
    } catch (error) {
      notify({ title: 'BrowserOS could not open it', body: String(error?.message ?? error), level: 'error' })
    }
  }

  return (
    <div className="page-enter flex h-full flex-col">
      <PageHeader
        icon="browser"
        title="Browser"
        subtitle="Browse inside Veritas OS, or hand the page to BrowserOS."
        actions={
          <>
            <Pill tone={browser?.server ? 'ok' : 'muted'} dot>
              {browser?.server ? `BrowserOS ${browser.version ?? ''}` : browser?.installed ? 'BrowserOS stopped' : 'BrowserOS not found'}
            </Pill>
            {browser && !browser.server && browser.installed ? (
              <GlassButton size="sm" variant="secondary" onClick={() => void window.heraldOS.browser.launch().then(setBrowser)}>
                <IconBrandChrome /> Start BrowserOS
              </GlassButton>
            ) : null}
          </>
        }
      />

      <div className="flex items-center gap-2 px-6 pb-3">
        <div className="glass-input flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg px-3">
          <IconLock size={13} className="shrink-0 text-fg-3" />
          <input
            value={address}
            onChange={event => setAddress(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                go(address)
              }
            }}
            placeholder="Search or enter a URL"
            className="min-w-0 flex-1 bg-transparent text-[12.5px] text-fg outline-none placeholder:text-fg-3"
          />
          {loading ? <span className="text-[11px] text-fg-3">loading…</span> : null}
        </div>
        <GlassButton size="sm" variant="secondary" aria-label="Reload" onClick={() => (viewId ? void window.heraldOS.web.reload(viewId) : go(address))}>
          <IconRefresh />
        </GlassButton>
        <GlassButton size="sm" variant="secondary" onClick={() => go(address)}>
          <IconWorld /> Go
        </GlassButton>
        <GlassButton size="sm" variant="primary" onClick={() => void openInBrowserOs()}>
          <IconExternalLink /> Open in BrowserOS
        </GlassButton>
      </div>

      {tabs.length > 0 ? (
        <div className="mx-6 mb-3 flex flex-wrap gap-1.5">
          {tabs.slice(0, 6).map(tab => (
            <button
              key={tab.id}
              type="button"
              onClick={() => {
                setAddress(tab.url)
                setUrl(tab.url)
              }}
              className={cn('max-w-[240px] truncate rounded-md border border-line bg-white/5 px-2 py-1 text-[11.5px] text-fg-2 hover:bg-white/10 hover:text-fg')}
              title={tab.url}
            >
              {tab.title || tab.url}
            </button>
          ))}
        </div>
      ) : null}

      <div className="relative mx-6 mb-6 min-h-0 flex-1 overflow-hidden rounded-xl border border-line" ref={content}>
        {!url ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-[13px] text-fg-3">
            <IconWorld size={26} />
            <div>Type a URL above to browse here — or open it in BrowserOS.</div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
