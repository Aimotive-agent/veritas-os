import { IconDatabase, IconFileText, IconListCheck, IconRobot, IconSparkles, IconTarget, IconTool, IconWorld } from '@tabler/icons-react'
import type { PillTone } from '../../components/ui/glass.tsx'
import type { ActivityEntry, Mission, MissionStatus, MissionStep } from '../../store/missions.ts'

/*
 * Pure helpers for the Missions page: icon choice, status vocabulary, agent naming and the time
 * formats the mockup uses ("9:28 AM", "Sep 18, 8:20 AM").
 */

export type TablerIcon = typeof IconTarget

export function missionIcon(title: string): TablerIcon {
  const text = title.toLowerCase()

  if (/\b(website|site|web ?page|landing)\b/.test(text)) {
    return IconWorld
  }

  if (/\b(brief|briefing|report|doc|document|memo|summary)\b/.test(text)) {
    return IconFileText
  }

  if (/\b(research|library|knowledge|sources?)\b/.test(text)) {
    return IconDatabase
  }

  return IconTarget
}

export const STATUS_LABEL: Record<MissionStatus, string> = {
  active: 'In progress',
  review: 'Needs review',
  queued: 'Queued',
  completed: 'Completed'
}

export const STATUS_TONE: Record<MissionStatus, PillTone> = {
  active: 'progress',
  review: 'warn',
  queued: 'muted',
  completed: 'ok'
}

/** A friendly role for the agent working on a goal, derived from what the goal asks for. */
export function deriveAgentName(goal: string): string {
  const text = goal.toLowerCase()

  if (/\b(research|analy[sz]e|compare|competitor|investigate|find out|survey)\b/.test(text)) {
    return 'Research agent'
  }

  if (/\b(design|mockup|concept|visual|brand|logo|layout)\b/.test(text)) {
    return 'Design agent'
  }

  if (/\b(build|code|implement|develop|website|site|app|deploy|fix|refactor)\b/.test(text)) {
    return 'Build agent'
  }

  if (/\b(organi[sz]e|library|knowledge|memory|catalog|index|tidy|sort)\b/.test(text)) {
    return 'Knowledge agent'
  }

  if (/\b(write|draft|brief|report|summar|document|email)\b/.test(text)) {
    return 'Writing agent'
  }

  return 'Hermes agent'
}

export function activityIcon(kind: ActivityEntry['kind']): TablerIcon {
  switch (kind) {
    case 'tool':
      return IconTool
    case 'agent':
      return IconRobot
    case 'plan':
      return IconListCheck
    case 'artifact':
      return IconFileText
    case 'turn':
    default:
      return IconSparkles
  }
}

const toMs = (ts: number) => (ts < 1e12 ? ts * 1000 : ts)

/** "9:28 AM". */
export function formatTime(ts: number): string {
  return new Date(toMs(ts)).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/** "Sep 18, 8:20 AM". */
export function formatStamp(ts: number): string {
  const date = new Date(toMs(ts))
  const day = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

  return `${day}, ${formatTime(ts)}`
}

/** Four generic phases for missions that never produced a todo plan. */
export function genericSteps(mission: Mission): MissionStep[] {
  const working = mission.status === 'active'
  const finished = mission.status === 'completed' || mission.status === 'review'

  return [
    { id: 'understand', label: 'Understand', state: 'done' },
    { id: 'work', label: 'Work', state: working ? 'active' : finished ? 'done' : 'pending' },
    { id: 'review', label: 'Review', state: mission.status === 'review' ? 'active' : mission.status === 'completed' ? 'done' : 'pending' },
    { id: 'done', label: 'Done', state: mission.status === 'completed' ? 'done' : 'pending' }
  ]
}

const IMAGE_RE = /\.(png|jpe?g|webp|gif)$/i
const TEXT_RE = /\.(md|markdown|txt|text|rst|json|ya?ml|toml|csv|html?|css|js|jsx|ts|tsx|py|rb|go|rs|sh|swift|java|kt|c|cc|cpp|h|hpp|sql|xml|log|env|ini|cfg)$/i

export type PreviewKind = 'image' | 'text' | 'file'

export function previewKind(path: string): PreviewKind {
  if (IMAGE_RE.test(path)) {
    return 'image'
  }

  if (TEXT_RE.test(path)) {
    return 'text'
  }

  return 'file'
}
