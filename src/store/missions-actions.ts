import { createChat, sendPrompt } from './chat.ts'
import { showPage } from './windows.ts'

const TITLE_MAX = 60

/** The prompt shape that makes a chat a mission (todo list first, then work, then a summary). */
export function missionPrompt(goal: string): string {
  return `Mission: ${goal}\n\nPlan this as a mission: first create a todo list of the concrete steps with the todo tool, then work through them, updating the todo list as you go, and finish with a short summary of what you produced.`
}

/** Start a mission in a fresh session and show it. Shared by the composer, the palette and voice. */
export async function startMission(goal: string, agentId = 'hermes'): Promise<{ sessionId: string; title: string }> {
  const trimmed = goal.trim()

  if (!trimmed) {
    throw new Error('A mission needs a goal.')
  }

  const title = trimmed.slice(0, TITLE_MAX)

  // Another agent runs the mission its own way (OpenCode takes the goal as a prompt), and its page
  // is where the work appears.
  if (agentId !== 'hermes') {
    await window.heraldOS.agents.run(agentId, trimmed)
    showPage(`agent:${agentId}`)

    return { sessionId: agentId, title }
  }

  const chat = await createChat({ title })
  void sendPrompt(missionPrompt(trimmed), { sessionId: chat.sessionId })
  showPage('hermes')

  return { sessionId: chat.sessionId, title }
}
