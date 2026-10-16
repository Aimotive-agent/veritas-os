import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'
import { useEffect } from 'react'
import { $connectionEpoch, gatewayRequest, isGatewayOpen } from '../../store/gateway.ts'

export interface SlashEntry {
  name: string
  description: string
}

const $catalog = atom<SlashEntry[]>([])
let loadedEpoch = -1

/** Slash commands (built-ins, quick commands, skills) from `commands.catalog`, refreshed per connection. */
export function useSlashCatalog(): SlashEntry[] {
  const epoch = useStore($connectionEpoch)
  const catalog = useStore($catalog)

  useEffect(() => {
    if (!isGatewayOpen() || loadedEpoch === epoch) {
      return
    }

    loadedEpoch = epoch
    gatewayRequest('commands.catalog', {})
      .then(result => {
        const entries: SlashEntry[] = []
        const seen = new Set<string>()

        for (const [name, description] of result.pairs ?? []) {
          const clean = String(name).replace(/^\//, '')

          if (clean && !seen.has(clean)) {
            seen.add(clean)
            entries.push({ name: clean, description: String(description ?? '') })
          }
        }

        $catalog.set(entries)
      })
      .catch(() => {
        loadedEpoch = -1
      })
  }, [epoch])

  return catalog
}
