import { atom } from 'nanostores'
import type { CatalogEntryView, CatalogGroupView } from '../../shared/ipc.ts'
import { localModelConfig, localModelSwitch } from '../lib/local-models.ts'
import { rest } from '../lib/rest.ts'
import { $activeChat } from './chat.ts'
import { gatewayRequest } from './gateway.ts'
import { notify } from './notifications.ts'

/*
 * The install catalog (linux/catalog/*.json): on Veritas OS Linux everything in it, on macOS the
 * coding agents and local model apps that install there. Main does the installing; this keeps the
 * listing and which entries are busy.
 */

export interface CatalogState {
  groups: CatalogGroupView[]
  loaded: boolean
  error: string | null
  /** Entries being installed or removed right now. */
  busy: Record<string, 'install' | 'remove'>
}

export const $catalog = atom<CatalogState>({ groups: [], loaded: false, error: null, busy: {} })

let loading: Promise<void> | null = null

export function loadCatalog(): Promise<void> {
  loading ??= window.heraldOS.catalog
    .list()
    .then(groups => $catalog.set({ ...$catalog.get(), groups, loaded: true, error: null }))
    .catch((error: unknown) => $catalog.set({ ...$catalog.get(), loaded: true, error: error instanceof Error ? error.message : String(error) }))
    .finally(() => {
      loading = null
    })

  return loading
}

export function catalogEntries(): CatalogEntryView[] {
  return $catalog.get().groups.flatMap(group => group.entries)
}

export function findCatalogEntry(query: string): CatalogEntryView | null {
  const needle = query.trim().toLowerCase()
  const entries = catalogEntries()

  return entries.find(entry => entry.id === needle) ?? entries.find(entry => entry.label.toLowerCase() === needle) ?? entries.find(entry => entry.label.toLowerCase().includes(needle)) ?? null
}

function setBusy(id: string, action: 'install' | 'remove' | null): void {
  const busy = { ...$catalog.get().busy }

  if (action) {
    busy[id] = action
  } else {
    delete busy[id]
  }

  $catalog.set({ ...$catalog.get(), busy })
}

/** Install or remove one entry; resolves with whether it worked (the toast says what happened). */
export async function runCatalog(id: string, action: 'install' | 'remove'): Promise<boolean> {
  const entry = catalogEntries().find(item => item.id === id)
  const label = entry?.label ?? id
  setBusy(id, action)

  try {
    const result = await (action === 'install' ? window.heraldOS.catalog.install(id) : window.heraldOS.catalog.remove(id))

    if (result.ok) {
      const opened = entry?.method === 'link' && action === 'install'
      notify({ title: opened ? `${label}: download page open` : `${label} ${action === 'install' ? 'installed' : 'removed'}`, body: opened ? 'Install it from there; Veritas OS sees it when it is done.' : result.output.split('\n').pop() || undefined, level: 'success' })
    } else {
      notify({ title: `Could not ${action} ${label}`, body: result.output || undefined, level: 'error' })
    }

    return result.ok
  } catch (error) {
    notify({ title: `Could not ${action} ${label}`, body: error instanceof Error ? error.message : String(error), level: 'error' })

    return false
  } finally {
    setBusy(id, null)
    await loadCatalog()
  }
}

/** Point Hermes at a model on Ollama or LM Studio: the default for new conversations, and the current one. */
export async function useWithHermes(kind: 'ollama' | 'lmstudio', model: string): Promise<void> {
  await rest.put('/api/config', { config: { model: localModelConfig(kind, model) } })
  const chat = $activeChat.get()

  if (chat) {
    await gatewayRequest('slash.exec', { session_id: chat.sessionId, command: `/model ${localModelSwitch(kind, model)}` }).catch(() => undefined)
  }
}
