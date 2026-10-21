import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/*
 * The Veritas agent's own settings, kept in ~/.config/veritas-os/veritas.json. The page, the
 * Telegram bridge and OpenCode's agent definition all read the same file, so the model the agent
 * runs on is the same everywhere.
 */

export interface VeritasProject {
  id: string
  name: string
  path: string
  sessionId: string
}

export interface VeritasConfig {
  telegram: { botToken: string; allowedChatIds: number[]; enabled: boolean }
  /** The model the agent runs on. */
  model: string
  /** The model used when an image is attached (the default one cannot read images). */
  visionModel: string
  projects: VeritasProject[]
  currentProject: string
}

export const VERITAS_DEFAULTS: Omit<VeritasConfig, 'projects' | 'currentProject'> = {
  telegram: { botToken: '', allowedChatIds: [], enabled: false },
  model: 'deepseek/deepseek-v4-pro',
  visionModel: 'omniroute/auto/best-vision'
}

export function veritasConfigPath(): string {
  return path.join(os.homedir(), '.config', 'veritas-os', 'veritas.json')
}

export function veritasTranscriptPath(): string {
  return path.join(os.homedir(), '.config', 'veritas-os', 'transcript.json')
}

/**
 * The configured model, or undefined when nothing is configured yet. OpenCode names models
 * `<provider>/<model>`, and the provider must exist in its config, so an unknown name is worse
 * than no name at all.
 */
export function veritasModel(): string | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(veritasConfigPath(), 'utf8')) as Partial<VeritasConfig>

    return typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : undefined
  } catch {
    return undefined
  }
}
