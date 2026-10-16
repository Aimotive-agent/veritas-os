import type { BluetoothDevice, ControlAction, DisplayInfo, NetworkStatus, StatusPanelId, StatusPanelState, SystemStats } from '../../shared/ipc.ts'
import { run } from './exec.ts'
import { HostNotSupported } from './types.ts'

/*
 * The quick panels on macOS are mostly for looking: macOS's own Control Center changes Wi-Fi,
 * Bluetooth and displays, and Veritas OS does not take that over. Volume is the exception.
 */

type SpDeviceList = Record<string, { device_address?: string; device_minorType?: string; device_batteryLevelMain?: string }>[]

interface SpBluetooth {
  SPBluetoothDataType?: {
    controller_properties?: { controller_state?: string }
    device_connected?: SpDeviceList
    device_not_connected?: SpDeviceList
  }[]
}

/** `system_profiler SPBluetoothDataType -json`. */
export function parseSpBluetooth(stdout: string): { powered: boolean; devices: BluetoothDevice[] } {
  let data: SpBluetooth

  try {
    data = JSON.parse(stdout) as SpBluetooth
  } catch {
    return { powered: false, devices: [] }
  }

  const root = data.SPBluetoothDataType?.[0] ?? {}
  const devices: BluetoothDevice[] = []
  const add = (entries: SpDeviceList | undefined, connected: boolean) => {
    for (const entry of entries ?? []) {
      for (const [name, info] of Object.entries(entry)) {
        const battery = info.device_batteryLevelMain ? Number(info.device_batteryLevelMain.replace('%', '')) : Number.NaN
        devices.push({ address: info.device_address ?? name, name, paired: true, connected, icon: info.device_minorType, battery: Number.isFinite(battery) ? battery : undefined })
      }
    }
  }

  add(root.device_connected, true)
  add(root.device_not_connected, false)

  return { powered: root.controller_properties?.controller_state === 'attrib_on', devices }
}

interface SpDisplays {
  SPDisplaysDataType?: { spdisplays_ndrvs?: { _name?: string; _spdisplays_resolution?: string; spdisplays_main?: string }[] }[]
}

/** `system_profiler SPDisplaysDataType -json`: "3456 x 2234 @ 120.00Hz". */
export function parseSpDisplays(stdout: string): DisplayInfo[] {
  let data: SpDisplays

  try {
    data = JSON.parse(stdout) as SpDisplays
  } catch {
    return []
  }

  return (data.SPDisplaysDataType ?? []).flatMap(gpu =>
    (gpu.spdisplays_ndrvs ?? []).map(display => {
      const match = /(\d+)\s*x\s*(\d+)(?:\s*@\s*([\d.]+)\s*Hz)?/i.exec(display._spdisplays_resolution ?? '')
      const name = display._name ?? 'Display'

      return { name, label: name, enabled: true, width: Number(match?.[1] ?? 0), height: Number(match?.[2] ?? 0), refresh: Number(match?.[3] ?? 0), scale: 1, modes: [] }
    })
  )
}

/** `pmset -g batt`: "…; 3:12 remaining present: true". */
export function parsePmsetTime(stdout: string): string | undefined {
  const match = /(\d+):(\d{2}) remaining/.exec(stdout)

  if (!match) {
    return undefined
  }

  const minutes = Number(match[1]) * 60 + Number(match[2])

  return /charging|AC Power/i.test(stdout) && !/discharging/i.test(stdout) ? `full in about ${minutes} minutes` : `about ${minutes >= 90 ? `${Math.round(minutes / 6) / 10} hours` : `${minutes} minutes`} left`
}

export async function darwinControlStatus(panel: StatusPanelId, stats: () => Promise<SystemStats>, network: () => Promise<NetworkStatus>): Promise<StatusPanelState> {
  switch (panel) {
    case 'wifi': {
      const status = await network()

      return { panel, wifi: { available: true, enabled: Boolean(status.wifi), connected: status.wifi?.ssid, networks: [] } }
    }
    case 'bluetooth': {
      const result = await run('system_profiler', ['SPBluetoothDataType', '-json'], 20_000)

      return { panel, bluetooth: { available: result.code === 0, ...parseSpBluetooth(result.stdout) } }
    }
    case 'audio': {
      const volume = await run('osascript', ['-e', 'set s to get volume settings', '-e', 'return (output volume of s as text) & "," & (output muted of s as text)'], 8000)
      const [level, muted] = volume.stdout.trim().split(',')

      return { panel, audio: { available: volume.code === 0, outputs: [{ id: 'default', name: 'Sound output', isDefault: true, volume: Number(level) || 0, muted: muted === 'true' }], inputs: [] } }
    }
    case 'display': {
      const result = await run('system_profiler', ['SPDisplaysDataType', '-json'], 20_000)
      const displays = parseSpDisplays(result.stdout)

      return { panel, display: { available: displays.length > 0, displays } }
    }
    case 'power': {
      const [sample, batt] = await Promise.all([stats(), run('pmset', ['-g', 'batt'], 5000)])

      return { panel, power: { available: true, battery: sample.battery, timeRemaining: parsePmsetTime(batt.stdout), profiles: [] } }
    }
    default:
      throw new Error(`no status for the ${panel} panel`)
  }
}

export async function darwinControlAction(action: ControlAction): Promise<void> {
  if (action.panel === 'audio' && action.action === 'volume') {
    if (action.percent !== undefined) {
      await run('osascript', ['-e', `set volume output volume ${Math.max(0, Math.min(100, Math.round(action.percent)))}`], 8000)
    }

    if (action.muted !== undefined) {
      await run('osascript', ['-e', `set volume output muted ${action.muted ? 'true' : 'false'}`], 8000)
    }

    return
  }

  throw new HostNotSupported(`changing ${action.panel} from Veritas OS on macOS (use Control Center)`)
}
