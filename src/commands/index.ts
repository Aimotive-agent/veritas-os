import { defineCommands } from '../store/os-commands.ts'
import { automationCommands } from './automations.ts'
import { canvasCommands } from './canvas.ts'
import { captureCommands } from './capture.ts'
import { connectionCommands } from './connections.ts'
import { continuityCommands } from './continuity.ts'
import { controlCommands } from './controls.ts'
import { crashCommands } from './crash.ts'
import { editCommands } from './edit.ts'
import { filesCommands } from './files.ts'
import { hermesCommands } from './hermes.ts'
import { agentsHubCommands } from './agents-hub.ts'
import { memoryCommands } from './memory.ts'
import { navigationCommands } from './navigation.ts'
import { openCommands } from './open.ts'
import { studioCommands } from './studio.ts'
import { screenCommands } from './screen.ts'
import { switchCommands } from './switches.ts'
import { systemCommands } from './system.ts'
import { themeCommands } from './themes.ts'
import { brandingCommands } from './branding.ts'
import { menuBarCommands } from './menubar.ts'
import { pluginCommands } from './plugins.ts'
import { softwareCommands } from './software.ts'
import { typingCommands } from './typing.ts'

let registered = false

/** Register every OS command once at boot. New user-visible actions belong in one of these files. */
export function registerOsCommands(): void {
  if (registered) {
    return
  }

  registered = true

  // A bad definition must not take the whole shell down with it; report and keep booting.
  for (const group of [agentsHubCommands, navigationCommands, editCommands, hermesCommands, memoryCommands, filesCommands, automationCommands, connectionCommands, systemCommands, studioCommands, openCommands, continuityCommands, crashCommands, themeCommands, screenCommands, controlCommands, switchCommands, captureCommands, typingCommands, softwareCommands, pluginCommands, menuBarCommands, brandingCommands, canvasCommands]) {
    try {
      defineCommands(group)
    } catch (error) {
      console.error('[os-commands] registration failed:', error)
    }
  }
}
