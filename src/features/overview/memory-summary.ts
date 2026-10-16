import type { MemoryState } from '../memory/memory-store.ts'

export interface MemorySummary {
  label: string
  detail: string
}

/**
 * The Overview memory card's two lines, or null until memory has been read once. Pausing turns off
 * the `memory` toolset, which stops new saves but leaves saved entries in every conversation.
 */
export function memorySummary(memory: Pick<MemoryState, 'entries' | 'loaded' | 'error'>, paused: boolean): MemorySummary | null {
  if (!memory.loaded) {
    return null
  }

  const count = memory.entries.length
  const entries = `${count} ${count === 1 ? 'entry' : 'entries'}`
  const detail = memory.error ? 'Could not read memory' : count === 0 ? 'Nothing remembered yet' : paused ? `${entries} still in use` : `${entries} remembered`

  return { label: paused ? 'Memory paused' : 'Memory on', detail }
}
