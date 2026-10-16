import { atom, computed } from 'nanostores'
import type { PluginPlacement, PluginView } from '../../shared/plugins.ts'

/** Installed widget plugins (ADR-019), kept in step with main (installs, toggles, saved files). */
export const $plugins = atom<PluginView[]>([])

export const $enabledPlugins = computed($plugins, plugins => plugins.filter(plugin => plugin.enabled))

export function pluginsAt(plugins: readonly PluginView[], placement: PluginPlacement): PluginView[] {
  return plugins.filter(plugin => plugin.enabled && plugin.manifest.placement.includes(placement))
}

let bound = false

export function bindPlugins(): () => void {
  const bridge = window.heraldOS?.plugins

  if (bound || !bridge) {
    return () => undefined
  }

  bound = true
  void bridge
    .list()
    .then(list => $plugins.set(list))
    .catch(() => undefined)
  const off = bridge.onChanged(list => $plugins.set(list))

  return () => {
    off()
    bound = false
  }
}
