import { buildBrief, projectSlug, uniqueName } from '../lib/build-brief.ts'
import { $env, $prefs } from './backend.ts'
import { createChat, sendPrompt } from './chat.ts'
import { markBuildSession, openStudio } from './studio.ts'

const TITLE_MAX = 60

export function projectsRoot(): string {
  const home = $env.get()?.homeDir ?? ''
  const configured = $prefs.get().projectsRoot?.trim()

  if (configured) {
    return configured.startsWith('~') ? home + configured.slice(1) : configured
  }

  return `${home}/Projects`
}

/**
 * "Build a website for a hair salon": a fresh project folder, a Hermes session working in it, and
 * the Studio open on that session before Hermes writes its first file.
 */
export async function startBuild(goal: string): Promise<{ sessionId: string; folder: string; title: string }> {
  const trimmed = goal.trim()

  if (!trimmed) {
    throw new Error('Say what to build.')
  }

  const root = projectsRoot()
  await window.heraldOS.fs.mkdir(root)
  const taken = new Set((await window.heraldOS.fs.readDir(root)).map(entry => entry.name))
  const folder = `${root}/${uniqueName(projectSlug(trimmed), taken)}`
  await window.heraldOS.fs.mkdir(folder)

  const title = (trimmed.charAt(0).toUpperCase() + trimmed.slice(1, TITLE_MAX)).trimEnd()
  const chat = await createChat({ cwd: folder, title })
  markBuildSession(chat.sessionId)
  openStudio(chat.sessionId, title)
  void sendPrompt(buildBrief(trimmed, folder), { sessionId: chat.sessionId })

  return { sessionId: chat.sessionId, folder, title }
}
