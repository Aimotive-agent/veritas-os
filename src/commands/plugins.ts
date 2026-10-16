import { focusSettings } from '../features/settings/sections/shared.tsx'
import { fail, ok, type OsCommand } from '../store/os-commands.ts'
import { $plugins } from '../store/plugins.ts'
import { openApp, showPage } from '../store/windows.ts'

/* Widget plugins (ADR-019). Turning one on stays in Settings > Plugins, where the person reads what it asks for. */

function findPlugin(name: unknown) {
  const needle = String(name ?? '').trim().toLowerCase()

  return $plugins.get().find(plugin => plugin.manifest.id === needle || plugin.manifest.name.toLowerCase() === needle) ?? null
}

export const pluginCommands: readonly OsCommand[] = [
  {
    id: 'plugin.list',
    title: 'Plugins',
    description: 'The widget plugins installed (menu bar, Overview, their own windows), which are on, and what each may do.',
    tier: 'read',
    args: [],
    run: async () => {
      const plugins = await window.heraldOS.plugins.list()
      $plugins.set(plugins)

      return ok(plugins.length ? plugins.map(plugin => `${plugin.manifest.name} (${plugin.enabled ? 'on' : 'off'})`).join(', ') : 'No plugins installed', {
        data: { plugins: plugins.map(plugin => ({ id: plugin.manifest.id, name: plugin.manifest.name, enabled: plugin.enabled, placement: plugin.manifest.placement, permissions: plugin.manifest.permissions, hosts: plugin.manifest.hosts, errors: plugin.errors })) },
        highlight: { kind: 'setting', id: 'plugins' }
      })
    }
  },
  {
    id: 'plugin.open',
    title: 'Open a widget',
    description: 'Open a widget plugin in its own window (for plugins whose placement includes panel).',
    tier: 'act',
    args: [{ name: 'name', type: 'string', description: 'Plugin id or name', required: true }],
    run: async ({ name }) => {
      const plugin = findPlugin(name)

      if (!plugin) {
        return fail(`No plugin "${String(name)}" (plugin.list shows them).`)
      }

      if (!plugin.enabled) {
        return fail(`${plugin.manifest.name} is off; turn it on in Settings > Plugins.`)
      }

      if (!plugin.manifest.placement.includes('panel')) {
        return fail(`${plugin.manifest.name} lives in the ${plugin.manifest.placement.join(' and ')}, not in a window.`)
      }

      openApp('widget', { payload: { plugin: plugin.manifest.id }, title: plugin.manifest.name, singleton: false })

      return ok(`Opened ${plugin.manifest.name}`)
    }
  },
  {
    id: 'plugin.manage',
    title: 'Manage plugins',
    description: 'Show Settings > Plugins, where plugins are turned on (after reading what they ask for), updated and removed.',
    tier: 'read',
    args: [],
    phrases: ['manage plugins', 'show my widgets'],
    run: async () => {
      showPage('settings')
      focusSettings({ section: 'plugins' })

      return ok('Settings > Plugins is open', { highlight: { kind: 'setting', id: 'plugins' } })
    }
  },
  {
    id: 'plugin.add',
    title: 'Install a plugin',
    description: 'Install a widget plugin from a git URL. It arrives turned off; the person turns it on in Settings > Plugins.',
    tier: 'mutate',
    args: [{ name: 'url', type: 'string', description: 'https or ssh git URL', required: true }],
    run: async ({ url }) => {
      const added = await window.heraldOS.plugins.add(String(url))

      return ok(`Installed ${added.manifest.name}, turned off: turn it on in Settings > Plugins`, { highlight: { kind: 'setting', id: 'plugins' } })
    }
  }
]
