import type { ToolCompletePayload, ToolStartPayload } from '@herald-os/client'
import { $env, $prefs } from './backend.ts'
import { $activeChatId, $chats } from './chat.ts'
import { followCommandFor, isBuildActivity } from './follow-map.ts'
import { onGatewayEvent } from './gateway.ts'
import { runCommand } from './os-commands.ts'
import { isMainSurface } from './shell.ts'
import { $buildSessions, openStudio, studioWindowFor } from './studio.ts'
import { $voiceActive } from './voice.ts'

/*
 * Follow Hermes: when Hermes's own tools change something that lives on a page (a memory entry, an
 * automation, a file), show it. On during a voice conversation (the user is watching, not typing)
 * or when the `followHermes` preference is on. Never while the user is typing in a field.
 *
 * Building is shown in the Studio: a session started with "build …" keeps its Studio up, and any
 * other session that starts writing code gets a one-time caption offering to show it.
 */

export { followCommandFor }

function userIsTyping(): boolean {
  const active = document.activeElement

  return Boolean(active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || (active as HTMLElement).isContentEditable))
}

let bound = false
const hinted = new Set<string>()
/** Build sessions whose Studio the user closed: never reopened behind their back. */
const dismissed = new Set<string>()
const opened = new Set<string>()

function onBuildActivity(sessionId: string): void {
  if (studioWindowFor(sessionId)) {
    opened.add(sessionId)
    return
  }

  // A build session, or the conversation the user is watching (voice, or Follow Hermes).
  const watching = sessionId === $activeChatId.get() && ($voiceActive.get() || $prefs.get().voice.followHermes)

  if ($buildSessions.get().has(sessionId) || watching) {
    // Opened once already and now gone: the user closed it.
    if (opened.has(sessionId)) {
      dismissed.add(sessionId)
    }

    if (!dismissed.has(sessionId)) {
      opened.add(sessionId)
      openStudio(sessionId, $chats.get()[sessionId]?.title || undefined)
    }

    return
  }

  if (sessionId === $activeChatId.get() && !hinted.has(sessionId)) {
    hinted.add(sessionId)
    void runCommand('studio.hint', {}, { source: 'follow' })
  }
}

export function bindFollow(): () => void {
  if (bound || !isMainSurface) {
    return () => undefined
  }

  bound = true
  const offStart = onGatewayEvent('tool.start', event => {
    const payload = event.payload as ToolStartPayload | undefined

    if (payload && event.session_id && isBuildActivity(payload.name)) {
      onBuildActivity(event.session_id)
    }
  })
  const off = onGatewayEvent('tool.complete', event => {
    const payload = event.payload as ToolCompletePayload | undefined

    if (!payload || event.session_id !== $activeChatId.get()) {
      return
    }

    const following = $voiceActive.get() || $prefs.get().voice.followHermes

    if (!following || userIsTyping() || !$env.get()) {
      return
    }

    // Code goes to the Studio (opened on tool.start), never a jump to the Files page.
    if (isBuildActivity(payload.name)) {
      return
    }

    const follow = followCommandFor(payload)

    if (follow) {
      void runCommand(follow.command, follow.args, { source: 'follow' })
    }
  })

  return () => {
    offStart()
    off()
    bound = false
  }
}
