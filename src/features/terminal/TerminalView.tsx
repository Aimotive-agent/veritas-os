import { useStore } from '@nanostores/react'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import { useEffect, useMemo, useRef } from 'react'
import { terminalColors } from '../../../shared/theme.ts'
import { cn } from '../../lib/cn.ts'
import { $prefs } from '../../store/backend.ts'

const MONO_STACK = 'SF Mono, JetBrains Mono, Menlo, monospace'

const THEME = {
  background: '#050f33',
  foreground: '#e9eefb',
  cursor: '#5296ff',
  cursorAccent: '#050f33',
  selectionBackground: 'rgba(82, 150, 255, 0.3)',
  black: '#101a3f',
  red: '#e5645b',
  green: '#5fc98a',
  yellow: '#e3a54a',
  blue: '#6aa9ff',
  magenta: '#c58af9',
  cyan: '#5fd1d6',
  white: '#c9ced6',
  brightBlack: '#5b6270',
  brightRed: '#f08078',
  brightGreen: '#7fe0a6',
  brightYellow: '#f0c070',
  brightBlue: '#8fbfff',
  brightMagenta: '#d7a8ff',
  brightCyan: '#84e6ea',
  brightWhite: '#f4f6f8'
}

/**
 * One live PTY rendered as xterm: the shared terminal renderer for the floating Terminal and the
 * embedded agent pages. Data flows through the terminal bridge (`window.heraldOS.terminal`).
 */
export function TerminalView({ id, active }: { id: string; active: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)
  const prefs = useStore($prefs)
  const theme = useMemo(() => (prefs.themeColors ? terminalColors(prefs.themeColors, prefs.themeScheme) : THEME), [prefs.themeColors, prefs.themeScheme])
  const fontFamily = prefs.fonts?.mono ? `${JSON.stringify(prefs.fonts.mono)}, ${MONO_STACK}` : MONO_STACK
  const initial = useRef({ theme, fontFamily })
  initial.current = { theme, fontFamily }

  useEffect(() => {
    if (term.current) {
      term.current.options.theme = theme
      term.current.options.fontFamily = fontFamily
      fit.current?.fit()
    }
  }, [theme, fontFamily])

  useEffect(() => {
    const el = host.current

    if (!el) {
      return
    }

    const terminal = new Terminal({
      theme: initial.current.theme,
      fontFamily: initial.current.fontFamily,
      fontSize: 12.5,
      lineHeight: 1.25,
      cursorBlink: true,
      cursorStyle: 'bar',
      allowProposedApi: true,
      scrollback: 8000,
      macOptionIsMeta: true
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(el)

    try {
      terminal.loadAddon(new WebglAddon())
    } catch {
      // Canvas renderer fallback is automatic.
    }

    term.current = terminal
    fit.current = fitAddon
    const offData = window.heraldOS.terminal.onData((tid, data) => {
      if (tid === id) {
        terminal.write(data)
      }
    })
    const onInput = terminal.onData(data => window.heraldOS.terminal.write(id, data))
    const onResize = terminal.onResize(({ cols, rows }) => window.heraldOS.terminal.resize(id, cols, rows))
    const observer = new ResizeObserver(() => {
      if (el.clientWidth > 0 && el.clientHeight > 0) {
        fitAddon.fit()
      }
    })
    observer.observe(el)
    fitAddon.fit()

    return () => {
      observer.disconnect()
      offData()
      onInput.dispose()
      onResize.dispose()
      terminal.dispose()
      term.current = null
    }
  }, [id])

  useEffect(() => {
    if (active) {
      requestAnimationFrame(() => {
        fit.current?.fit()
        term.current?.focus()
      })
    }
  }, [active])

  return <div ref={host} className={cn('absolute inset-x-3 inset-y-0 bottom-3 overflow-hidden rounded-lg hairline', !active && 'invisible')} style={{ background: theme.background }} />
}
