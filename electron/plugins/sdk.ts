/**
 * herald-plugin://sdk/widget.js: what a widget includes to talk to the shell. Everything goes
 * through postMessage to the shell's frame host; the reply comes back with the same id.
 *
 *   herald.stats() · herald.notify(title, body) · herald.storage.get(key) / .set(key, value)
 *   herald.run('page.open', { name: 'missions' }) · herald.onTheme(colors => …)
 *   herald.placement: 'menubar' (a 24 px strip), 'overview' (a card) or 'panel' (its own window)
 *
 * The theme also arrives as CSS variables on :root (--herald-bg, --herald-fg, --herald-accent, …).
 */
export const WIDGET_SDK = `(() => {
  let next = 0
  const pending = new Map()
  const themeListeners = new Set()
  let theme = null
  window.addEventListener('message', event => {
    if (event.source !== window.parent) return
    const message = event.data
    if (!message || message.herald !== 1) return
    if (message.reply !== undefined) {
      const call = pending.get(message.reply)
      if (!call) return
      pending.delete(message.reply)
      if (message.error) call.reject(new Error(message.error))
      else call.resolve(message.result)
    } else if (message.event === 'theme') {
      theme = message.colors || {}
      for (const [key, value] of Object.entries(theme)) {
        document.documentElement.style.setProperty('--herald-' + key.replace(/_/g, '-'), String(value))
      }
      document.documentElement.dataset.scheme = message.scheme || 'dark'
      document.documentElement.style.colorScheme = message.scheme === 'light' ? 'light' : 'dark'
      for (const listener of themeListeners) listener(theme)
    }
  })
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++next
    pending.set(id, { resolve, reject })
    window.parent.postMessage({ herald: 1, id, method, params: params || {} }, '*')
  })
  const query = new URLSearchParams(location.search)
  const placement = query.get('at') || 'panel'
  document.documentElement.dataset.placement = placement
  // The same colour scheme as the frame around it, or Chromium paints the frame opaque.
  document.documentElement.style.colorScheme = query.get('scheme') === 'light' ? 'light' : 'dark'
  window.herald = Object.freeze({
    placement,
    stats: () => call('stats'),
    notify: (title, body) => call('notify', { title, body }),
    storage: Object.freeze({ get: key => call('storage.get', { key }), set: (key, value) => call('storage.set', { key, value }) }),
    run: (command, args) => call('run', { command, args }),
    onTheme: listener => { themeListeners.add(listener); if (theme) listener(theme); return () => themeListeners.delete(listener) }
  })
  window.parent.postMessage({ herald: 1, ready: true }, '*')
})()
`
