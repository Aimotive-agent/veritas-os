import { useEffect } from 'react'
import { openStoredSession } from '../../store/chat.ts'
import { ChatSurface } from '../chat/ChatSurface.tsx'

/** A conversation in its own floating window. */
export function ChatPopout({ sessionId }: { sessionId?: string }) {
  useEffect(() => {
    if (sessionId) {
      void openStoredSession(sessionId)
    }
  }, [sessionId])

  return <ChatSurface />
}
