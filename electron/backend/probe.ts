const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Wait until `GET /api/status` answers with the session token. The ready line only proves the
 * socket is bound; the ASGI app may still be finishing startup.
 */
export async function waitForStatus(baseUrl: string, token: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError = 'no response'

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new Error('backend probe cancelled')
    }

    try {
      const response = await fetch(`${baseUrl}/api/status`, {
        headers: { 'X-Hermes-Session-Token': token },
        signal: AbortSignal.timeout(2500)
      })

      if (response.ok) {
        return
      }

      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }

    await sleep(250)
  }

  throw new Error(`backend did not become ready: ${lastError}`)
}
