/** An error's message as the person reads it: without the prefix Electron puts on errors that come from main. */
export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '')
