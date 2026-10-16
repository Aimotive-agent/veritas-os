import { useStore } from '@nanostores/react'
import { useCallback, useSyncExternalStore } from 'react'
import type { CanvasDocument } from './engine/document.ts'
import { $activeKey, $documents } from './store.ts'

/** Re-render when a document changes; returns its revision. */
export function useRevision(doc: CanvasDocument | null): number {
  const subscribe = useCallback((listener: () => void) => (doc ? doc.subscribe(listener) : () => {}), [doc])

  return useSyncExternalStore(subscribe, () => doc?.revision ?? -1)
}

/** The document in front, kept current as it changes. */
export function useActiveDocument(): CanvasDocument | null {
  const documents = useStore($documents)
  const key = useStore($activeKey)
  const doc = documents.find((entry) => entry.key === key) ?? null
  useRevision(doc)

  return doc
}
