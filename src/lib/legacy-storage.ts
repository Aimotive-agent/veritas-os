type KeyValueStorage = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>

const LEGACY_PREFIX = 'hermes-os.'
const PREFIX = 'herald-os.'

/** Moves shell settings saved under the pre-rename `hermes-os.` prefix; a value already saved under the new name wins. */
export function migrateLegacyStorage(storage: KeyValueStorage): number {
  const legacy: string[] = []

  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index)

    if (key?.startsWith(LEGACY_PREFIX)) {
      legacy.push(key)
    }
  }

  for (const key of legacy) {
    const next = PREFIX + key.slice(LEGACY_PREFIX.length)

    if (storage.getItem(next) === null) {
      storage.setItem(next, storage.getItem(key) ?? '')
    }

    storage.removeItem(key)
  }

  return legacy.length
}

// Imported first by main.tsx: stores read their saved state while their modules load.
if (typeof window !== 'undefined' && window.localStorage) {
  migrateLegacyStorage(window.localStorage)
}
