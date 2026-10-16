// Pure helpers for the model-provider sign-in (no DOM): shared by the store and its tests.

const AUTH_ERROR = /access token|logged out|not logged in|login|relogin|Nous Portal|oauth|unauthori[sz]ed|\b401\b|invalid_grant|refresh session/i

/** True when a turn failed because the model provider needs the user to sign in. */
export function isAuthErrorText(text: string | undefined | null): boolean {
  return Boolean(text && AUTH_ERROR.test(text))
}

/** `model.provider` from the raw YAML; the schema view flattens `model` to a string. */
export function parseActiveProvider(yaml: string): string | null {
  const block = /^model:\s*\n((?:[ \t]+.*\n?)*)/m.exec(yaml)
  const match = block ? /^[ \t]+provider:\s*['"]?([\w.-]+)['"]?/m.exec(block[1]) : null

  return match?.[1] ?? null
}
