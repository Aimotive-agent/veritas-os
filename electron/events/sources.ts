import { powerMonitor } from 'electron'
import type { BatteryStatus, NetworkStatus } from '../../shared/ipc.ts'
import { hostPlatform } from '../platform/index.ts'
import { events } from './bus.ts'

/** "I logged in" is the shell starting; wait until the session has settled before saying so. */
const LOGIN_DELAY_MS = 8000
const BATTERY_POLL_MS = 120_000
const NETWORK_POLL_MS = 60_000
export const LOW_BATTERY_PERCENT = 15
/** The low-battery event fires again only after the battery recovered past this. */
export const BATTERY_RESET_PERCENT = 20

/** Whether a battery reading is the moment it became low; `armed` is false while an alert is outstanding. */
export function batteryCrossing(armed: boolean, battery: BatteryStatus | undefined): { fire: boolean; armed: boolean } {
  if (!battery?.present || typeof battery.percent !== 'number') {
    return { fire: false, armed }
  }

  if (battery.charging || battery.percent >= BATTERY_RESET_PERCENT) {
    return { fire: false, armed: true }
  }

  if (armed && battery.percent <= LOW_BATTERY_PERCENT) {
    return { fire: true, armed: false }
  }

  return { fire: false, armed }
}

/** What counts as "the network changed": going on or offline, or joining a different Wi-Fi network. */
export function networkKey(status: NetworkStatus | null): string {
  if (!status) {
    return 'unknown'
  }

  return `${status.online ? 'online' : 'offline'}|${status.wifi?.connected ? (status.wifi.ssid ?? 'wifi') : ''}`
}

export function startEventSources(): void {
  setTimeout(() => events.emit('login'), LOGIN_DELAY_MS).unref()

  powerMonitor.on('suspend', () => events.emit('sleep'))
  powerMonitor.on('resume', () => events.emit('wake'))
  powerMonitor.on('lock-screen', () => events.emit('lock'))
  powerMonitor.on('unlock-screen', () => events.emit('unlock'))

  let armed = true
  setInterval(() => {
    void hostPlatform()
      .sampleStats()
      .then(stats => {
        const verdict = batteryCrossing(armed, stats.battery)
        armed = verdict.armed

        if (verdict.fire) {
          events.emit('battery-low', { percent: stats.battery.percent })
        }
      })
      .catch(() => undefined)
  }, BATTERY_POLL_MS).unref()

  let lastNetwork: string | null = null
  setInterval(() => {
    void hostPlatform()
      .networkStatus()
      .then(status => {
        const key = networkKey(status)

        if (lastNetwork !== null && key !== lastNetwork) {
          events.emit('network-change', { online: status.online, wifi: status.wifi?.connected ? status.wifi.ssid : undefined })
        }

        lastNetwork = key
      })
      .catch(() => undefined)
  }, NETWORK_POLL_MS).unref()
}
