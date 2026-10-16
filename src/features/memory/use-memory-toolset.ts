import { useState } from 'react'
import { rest } from '../../lib/rest.ts'
import { useBackendData } from '../../lib/use-async.ts'
import { notify } from '../../store/notifications.ts'

interface ToolsetRow {
  name: string
  label?: string
  enabled?: boolean
  [key: string]: unknown
}

export interface MemoryToolsetState {
  /** True when the `memory` toolset is disabled: Hermes cannot save or edit memories, but still uses the saved ones. */
  paused: boolean
  /** False until GET /api/tools/toolsets has answered with a `memory` row. */
  known: boolean
  busy: boolean
  setPaused: (paused: boolean) => Promise<void>
}

/**
 * "Pause memory" = disable the `memory` toolset (PUT /api/tools/toolsets/memory {enabled}). Hermes
 * keeps that in `platform_toolsets.cli`, so the `hermes` command line is paused too. Saved memories
 * still reach every session, and an external memory provider such as Honcho keeps recalling and
 * saving. Optimistic: the override applies until the next successful refetch replaces it.
 */
export function useMemoryToolset(): MemoryToolsetState {
  const toolsets = useBackendData(() => rest.get<ToolsetRow[]>('/api/tools/toolsets'))
  const [override, setOverride] = useState<{ data: ToolsetRow[] | null; enabled: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const row = toolsets.data?.find(item => item.name === 'memory')
  const enabled = override && override.data === toolsets.data ? override.enabled : (row?.enabled ?? true)

  const setPaused = async (paused: boolean) => {
    setOverride({ data: toolsets.data, enabled: !paused })
    setBusy(true)

    try {
      await rest.put(`/api/tools/toolsets/memory`, { enabled: !paused })
      notify({ title: paused ? 'Memory paused' : 'Memory resumed', body: paused ? 'Hermes stops saving to its own memory, in its CLI too, but still uses it.' : 'Hermes can save memories again.', level: 'success' })
    } catch (err) {
      setOverride(null)
      notify({ title: paused ? 'Could not pause memory' : 'Could not resume memory', body: err instanceof Error ? err.message : String(err), level: 'error' })
    } finally {
      setBusy(false)
      toolsets.reload()
    }
  }

  return { paused: !enabled, known: row != null, busy, setPaused }
}
