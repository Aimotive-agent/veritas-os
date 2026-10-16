/*
 * Careful line-level edits of the Veritas OS bridge policy (YAML text owned by Electron's
 * `bridge.readPolicy/writePolicy`). We never re-serialise the document: comments and unknown
 * keys survive, only the `tiers:` values we were asked to change move.
 */

export type PolicyTier = 'read' | 'act' | 'mutate' | 'destructive'
export type TierDecision = 'allow' | 'confirm' | 'deny'

const TIER_LINE = /^(\s+)(read|act|mutate|destructive)\s*:\s*([^\s#]+)?(.*)$/

function tiersBlock(lines: string[]): { start: number; end: number } | null {
  const start = lines.findIndex(line => /^tiers\s*:\s*(#.*)?$/.test(line))

  if (start === -1) {
    return null
  }

  let end = start + 1

  while (end < lines.length && (lines[end].trim() === '' || /^\s/.test(lines[end]))) {
    end++
  }

  return { start, end }
}

export function readTier(text: string, tier: PolicyTier): TierDecision | null {
  const lines = text.split('\n')
  const block = tiersBlock(lines)

  if (!block) {
    return null
  }

  for (let i = block.start + 1; i < block.end; i++) {
    const match = TIER_LINE.exec(lines[i])

    if (match && match[2] === tier) {
      const value = (match[3] ?? '').toLowerCase()

      return value === 'allow' || value === 'confirm' || value === 'deny' ? value : null
    }
  }

  return null
}

/** Returns the policy with `tier: value` replaced (or inserted) inside the `tiers:` block. */
export function withTier(text: string, tier: PolicyTier, value: TierDecision): string {
  const lines = text.split('\n')
  const block = tiersBlock(lines)

  if (!block) {
    const trimmed = text.replace(/\s+$/, '')

    return `${trimmed}${trimmed ? '\n' : ''}tiers:\n  ${tier}: ${value}\n`
  }

  for (let i = block.start + 1; i < block.end; i++) {
    const match = TIER_LINE.exec(lines[i])

    if (match && match[2] === tier) {
      lines[i] = `${match[1]}${tier}: ${value}${match[4] ?? ''}`

      return lines.join('\n')
    }
  }

  // Key missing from the block: insert right after `tiers:` with the block's indentation.
  const sibling = lines.slice(block.start + 1, block.end).find(line => TIER_LINE.test(line))
  const indent = sibling ? (TIER_LINE.exec(sibling)?.[1] ?? '  ') : '  '
  lines.splice(block.start + 1, 0, `${indent}${tier}: ${value}`)

  return lines.join('\n')
}

export function withTiers(text: string, patch: Partial<Record<PolicyTier, TierDecision>>): string {
  return (Object.entries(patch) as [PolicyTier, TierDecision][]).reduce((acc, [tier, value]) => withTier(acc, tier, value), text)
}
