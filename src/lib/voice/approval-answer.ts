// Spoken answers to an approval card. While one of the voice conversation's approval cards is up, a
// short "yes" or "no" decides it instead of interrupting the turn; anything else ("yes, but call it
// Acme") is a new request as before. Whole utterances only. Pure, so it is unit-tested in node.

export type ApprovalAnswer = 'approve' | 'deny'

type Word = ApprovalAnswer | 'filler'

const VOCABULARY = new Map<string, Word>([
  ...[
    'yes', 'yeah', 'yep', 'yup', 'sure', 'okay', 'ok', 'alright', 'all right', 'go ahead', 'go for it', 'do it', 'please do',
    'approve', 'approve it', 'approved', 'allow', 'allow it', 'allow once', 'confirm', 'confirmed', 'sounds good', 'thats fine',
    'that is fine', 'fine', 'of course', 'absolutely'
  ].map(phrase => [phrase, 'approve'] as const),
  ...[
    'no', 'nope', 'nah', 'cancel', 'cancel it', 'cancel that', 'dont', 'dont do it', 'dont do that', 'do not', 'do not do it',
    'do not do that', 'stop', 'stop it', 'deny', 'deny it', 'denied', 'not now', 'not yet'
  ].map(phrase => [phrase, 'deny'] as const),
  // Words that ride along with either answer: "yes please", "no thanks", "hey Hermes, do it".
  ...['please', 'thanks', 'thank you', 'hey', 'hermes', 'just', 'then'].map(phrase => [phrase, 'filler'] as const)
])

const LONGEST_PHRASE = Math.max(...[...VOCABULARY.keys()].map(phrase => phrase.split(' ').length))
const MAX_WORDS = 8

/** "Yes, go ahead." -> approve; "No, don't." -> deny; anything with other words or both answers -> null. */
export function matchApprovalAnswer(text: string): ApprovalAnswer | null {
  const words = text
    .toLowerCase()
    .replace(/[’‘']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)

  if (words.length === 0 || words.length > MAX_WORDS) {
    return null
  }

  const found = new Set<Word>()

  for (let i = 0; i < words.length; ) {
    let length = Math.min(LONGEST_PHRASE, words.length - i)

    while (length > 0 && !VOCABULARY.has(words.slice(i, i + length).join(' '))) {
      length--
    }

    if (length === 0) {
      return null
    }

    found.add(VOCABULARY.get(words.slice(i, i + length).join(' ')) as Word)
    i += length
  }

  if (found.has('approve') === found.has('deny')) {
    return null
  }

  return found.has('approve') ? 'approve' : 'deny'
}

/** What this needs of a pending server request (store/requests.ts `PendingRequest` fits). */
export interface PendingCard {
  kind: string
  request: { id: string; params: { session_id?: unknown; gateway_session_id?: unknown } }
}

/** The approval card a spoken answer goes to: the oldest one waiting on the voice conversation's session. */
export function voiceApprovalFor<T extends PendingCard>(pending: readonly T[], sessionId: string | null): T | null {
  if (!sessionId) {
    return null
  }

  return pending.find(entry => entry.kind === 'approval' && (entry.request.params.session_id === sessionId || entry.request.params.gateway_session_id === sessionId)) ?? null
}

export interface VoiceApprovalDecision {
  requestId: string
  answer: ApprovalAnswer
  /** Never "session" or "always": a spoken yes allows this one action and leaves no standing rule. */
  choice: 'once' | 'deny'
}

/** Which card a spoken answer decides and how, or null when no card waits or the words are no answer. */
export function decideVoiceApproval(pending: readonly PendingCard[], sessionId: string | null, text: string): VoiceApprovalDecision | null {
  const card = voiceApprovalFor(pending, sessionId)
  const answer = card ? matchApprovalAnswer(text) : null

  return card && answer ? { requestId: card.request.id, answer, choice: answer === 'approve' ? 'once' : 'deny' } : null
}
