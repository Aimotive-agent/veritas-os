import { useStore } from '@nanostores/react'
import { IconListSearch } from '@tabler/icons-react'
import { useState } from 'react'
import { Toggle } from '../../../components/ui/glass.tsx'
import { useBackendData } from '../../../lib/use-async.ts'
import { $backend } from '../../../store/backend.ts'
import { notify } from '../../../store/notifications.ts'
import { readToolSearch, setToolSearch } from '../../../store/tool-search.ts'
import { errorText, InlineNote, markSaved, SettingsRow } from './shared.tsx'

/*
 * Tool search: Hermes's `tools.tool_search.enabled` (/api/config), one setting for every Hermes
 * session. Veritas OS turns it off at setup (ADR-010); this is where it goes back on.
 */

export function ToolSearchRow() {
  const setting = useBackendData(readToolSearch)
  const bridgeError = useStore($backend).bridgeError
  const [override, setOverride] = useState<{ base: unknown; on: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const on = override && override.base === setting.data ? override.on : setting.data

  const toggle = async (next: boolean) => {
    setOverride({ base: setting.data, on: next })
    setBusy(true)

    try {
      await setToolSearch(next)
      markSaved()
      notify({ title: next ? 'Tool search on' : 'Tool search off', body: next ? 'Hermes looks plugin and MCP tools up when it needs them.' : "Veritas OS's system tools stay directly callable.", level: 'success' })
    } catch (error) {
      setOverride(null)
      notify({ title: 'Could not change tool search', body: errorText(error), level: 'error' })
    } finally {
      setBusy(false)
      setting.reload()
    }
  }

  return (
    <SettingsRow
      icon={<IconListSearch />}
      label="Tool search"
      description="Hermes looks plugin and MCP tools up when it needs them, using fewer prompt tokens. Off, Veritas OS's system tools stay at hand instead of behind a search. Applies to every Hermes session, from its next conversation."
      keywords="tool search defer plugins mcp system tools bridge prompt tokens"
      below={bridgeError ? <InlineNote tone="danger">Veritas OS could not set its system tools up in Hermes: {bridgeError}. It tries again at its next start.</InlineNote> : undefined}
    >
      <Toggle checked={on ?? false} onChange={next => void toggle(next)} label="Tool search" disabled={busy || on === null || on === undefined} />
    </SettingsRow>
  )
}
