import { $catalog, catalogEntries, findCatalogEntry, loadCatalog, runCatalog, useWithHermes } from '../store/catalog.ts'
import { fail, ok, type OsCommand } from '../store/os-commands.ts'
import { openTerminalProgram } from '../store/terminal.ts'

/* The install catalog: coding agents, local models, languages, editors, games, Windows, web apps. */

async function entryFor(name: unknown) {
  if (!$catalog.get().loaded) {
    await loadCatalog()
  }

  return findCatalogEntry(String(name ?? ''))
}

export const softwareCommands: readonly OsCommand[] = [
  {
    id: 'software.list',
    title: 'Software catalog',
    description: 'What the install catalog offers and what is installed: coding agents, local models, languages, editors, terminals, games, the Windows VM, media apps, services and web apps.',
    tier: 'read',
    args: [],
    run: async () => {
      await loadCatalog()
      const entries = catalogEntries()
      const installed = entries.filter(entry => entry.installed).map(entry => entry.label)

      return ok(installed.length ? `${installed.length} of ${entries.length} installed: ${installed.join(', ')}` : `${entries.length} things to install, none yet`, {
        data: { groups: $catalog.get().groups.map(group => ({ group: group.label, entries: group.entries.map(entry => `${entry.id}: ${entry.label} (${entry.installed ? 'installed' : entry.available ? 'available' : entry.reason})`) })) },
        highlight: { kind: 'setting', id: 'software' }
      })
    }
  },
  {
    id: 'software.install',
    title: 'Install software',
    description: 'Install something from the catalog by id or name (claude-code, node, zed, steam, windows, discord…), the right way for this machine.',
    tier: 'mutate',
    args: [{ name: 'name', type: 'string', description: 'Catalog id or name', required: true }],
    phrases: ['install {name}', 'get me {name}'],
    run: async ({ name }) => {
      const entry = await entryFor(name)

      if (!entry) {
        return fail(`"${String(name)}" is not in the software catalog. software.list shows what is.`)
      }

      if (entry.installed) {
        return ok(`${entry.label} is already installed`)
      }

      if (!entry.available) {
        return fail(`${entry.label} cannot be installed here: ${entry.reason ?? 'not on this computer'}.`)
      }

      return (await runCatalog(entry.id, 'install')) ? ok(entry.method === 'link' ? `Opened the ${entry.label} download page` : `Installed ${entry.label}`) : fail(`Could not install ${entry.label}; the notification says why.`)
    }
  },
  {
    id: 'software.remove',
    title: 'Remove software',
    description: 'Remove something that was installed from the catalog.',
    tier: 'destructive',
    args: [{ name: 'name', type: 'string', description: 'Catalog id or name', required: true }],
    phrases: ['uninstall {name}', 'remove {name}'],
    run: async ({ name }) => {
      const entry = await entryFor(name)

      if (!entry?.installed) {
        return fail(entry ? `${entry.label} is not installed.` : `"${String(name)}" is not in the software catalog.`)
      }

      if (!entry.removable) {
        return fail(`${entry.label} was not installed from the catalog, so remove it the way it was installed.`)
      }

      return (await runCatalog(entry.id, 'remove')) ? ok(`Removed ${entry.label}`) : fail(`Could not remove ${entry.label}; the notification says why.`)
    }
  },
  {
    id: 'software.agent',
    title: 'Open a coding agent',
    description: 'Open an installed coding agent (Claude Code, Codex, OpenCode, Gemini CLI, Copilot CLI) in a new Terminal tab.',
    tier: 'act',
    args: [{ name: 'name', type: 'string', description: 'The agent: claude-code, codex, opencode, gemini-cli or copilot-cli', required: true }],
    phrases: ['open {name} in the terminal', 'start {name}'],
    run: async ({ name }) => {
      const entry = await entryFor(name)

      if (!entry?.terminal) {
        return fail(`"${String(name)}" is not a coding agent from the catalog.`)
      }

      if (!entry.installed) {
        return fail(`${entry.label} is not installed yet; software.install installs it.`)
      }

      openTerminalProgram(entry.id, entry.label)

      return ok(`${entry.label} is starting in the Terminal`)
    }
  },
  {
    id: 'software.localModel',
    title: 'Use a local model',
    description: 'Point Hermes at a model running on this computer through Ollama or LM Studio. Without a model, lists the ones the server has.',
    tier: 'mutate',
    args: [
      { name: 'server', type: 'string', description: 'ollama or lmstudio', required: true, enum: ['ollama', 'lmstudio'] },
      { name: 'model', type: 'string', description: 'The model name as the server lists it' }
    ],
    run: async ({ server, model }) => {
      const kind = server === 'lmstudio' ? 'lmstudio' : 'ollama'
      const models = await window.heraldOS.catalog.localModels(kind)

      if (!model) {
        return ok(`Models on ${kind === 'ollama' ? 'Ollama' : 'LM Studio'}: ${models.join(', ')}`, { data: { models } })
      }

      const chosen = models.find(name => name === model) ?? models.find(name => name.toLowerCase().startsWith(String(model).toLowerCase()))

      if (!chosen) {
        return fail(`No model "${String(model)}" there. It has: ${models.join(', ')}.`)
      }

      await useWithHermes(kind, chosen)

      return ok(`Hermes now uses ${chosen} on this computer`)
    }
  }
]
