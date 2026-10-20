import { atom } from 'nanostores'
import type { ShellMission } from '../../shared/ipc.ts'

/** Missions the shell handed to non-Hermes agents, mirrored from the main process. */
export const $shellMissions = atom<ShellMission[]>([])

let bound = false

/** Start mirroring the shell-tracked missions once; safe to call from several components. */
export function bindShellMissions(): void {
  if (bound) {
    return
  }

  bound = true
  void window.heraldOS.shellMissions.list().then(missions => $shellMissions.set(missions))
  window.heraldOS.shellMissions.onChanged(missions => $shellMissions.set(missions))
}
