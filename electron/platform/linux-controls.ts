import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AudioDevice, AudioState, BluetoothDevice, BluetoothState, ControlAction, DisplayInfo, DisplayMode, DisplayState, PowerState, StatusPanelId, StatusPanelState, SystemStats, WifiNetwork, WifiState } from '../../shared/ipc.ts'
import { MISSING_BINARY, run } from './exec.ts'
import { HostNotSupported } from './types.ts'

/*
 * The menu bar's quick panels on Linux: NetworkManager (nmcli), BlueZ (bluetoothctl), PipeWire
 * through its PulseAudio interface (pactl), niri's output IPC, brightnessctl, power-profiles-daemon
 * and UPower. The parse* functions are pure and tested with captured output.
 */

// ---- Parsing ------------------------------------------------------------------------------------

/** nmcli's terse format: fields split on ':', with ':' and '\' escaped by a backslash. */
export function splitTerse(line: string): string[] {
  const fields: string[] = []
  let current = ''

  for (let i = 0; i < line.length; i++) {
    const char = line[i]

    if (char === '\\' && i + 1 < line.length) {
      current += line[++i]
    } else if (char === ':') {
      fields.push(current)
      current = ''
    } else {
      current += char
    }
  }

  fields.push(current)

  return fields
}

/** `nmcli -t -f IN-USE,SSID,SIGNAL,SECURITY dev wifi list`: one entry per network name, strongest access point. */
export function parseWifiList(stdout: string, known: ReadonlySet<string>): WifiNetwork[] {
  const byName = new Map<string, WifiNetwork>()

  for (const line of stdout.split('\n')) {
    if (!line.trim()) {
      continue
    }

    const [inUse, ssid, signal, security] = splitTerse(line)

    if (!ssid) {
      continue
    }

    const network: WifiNetwork = { ssid, signal: Math.max(0, Math.min(100, Number(signal) || 0)), secure: Boolean(security && security !== '--'), active: inUse === '*', known: known.has(ssid) }
    const seen = byName.get(ssid)

    byName.set(ssid, seen ? { ...seen, signal: Math.max(seen.signal, network.signal), active: seen.active || network.active } : network)
  }

  return [...byName.values()].sort((a, b) => Number(b.active) - Number(a.active) || Number(b.known) - Number(a.known) || b.signal - a.signal)
}

/** `nmcli -t -f NAME,TYPE connection show`: the saved Wi-Fi connection names. */
export function parseKnownWifi(stdout: string): Set<string> {
  const names = new Set<string>()

  for (const line of stdout.split('\n')) {
    const [name, type] = splitTerse(line)

    if (name && (type === '802-11-wireless' || type === 'wifi')) {
      names.add(name)
    }
  }

  return names
}

/** `bluetoothctl show`: whether the adapter is on. */
export function parseBluetoothShow(stdout: string): { present: boolean; powered: boolean } {
  return { present: /^Controller\s/m.test(stdout), powered: /^\s*Powered:\s*yes/m.test(stdout) }
}

/** `bluetoothctl devices`: "Device AA:BB:CC:DD:EE:FF Name". */
export function parseBluetoothDevices(stdout: string): { address: string; name: string }[] {
  return stdout
    .split('\n')
    .map(line => /^Device\s+([0-9A-F:]{17})(?:\s+(.*))?$/i.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null)
    .map(([, address, name]) => ({ address: address.toUpperCase(), name: name?.trim() || address }))
}

/** `bluetoothctl info <address>`. */
export function parseBluetoothInfo(stdout: string): Pick<BluetoothDevice, 'paired' | 'connected' | 'icon' | 'battery'> {
  const battery = /Battery Percentage:\s*0x[0-9a-f]+\s*\((\d+)\)/i.exec(stdout)?.[1]

  return {
    paired: /^\s*Paired:\s*yes/m.test(stdout),
    connected: /^\s*Connected:\s*yes/m.test(stdout),
    icon: /^\s*Icon:\s*(\S+)/m.exec(stdout)?.[1],
    battery: battery ? Number(battery) : undefined
  }
}

interface PactlNode {
  name?: string
  description?: string
  mute?: boolean
  volume?: Record<string, { value_percent?: string }>
}

/** `pactl -f json list sinks|sources`, without the monitor sources PipeWire adds for every output. */
export function parsePactl(stdout: string, defaultName: string): AudioDevice[] {
  let nodes: PactlNode[]

  try {
    nodes = JSON.parse(stdout) as PactlNode[]
  } catch {
    return []
  }

  return (Array.isArray(nodes) ? nodes : [])
    .filter(node => node.name && !node.name.endsWith('.monitor'))
    .map(node => {
      const levels = Object.values(node.volume ?? {})
        .map(channel => parseInt(channel.value_percent ?? '', 10))
        .filter(Number.isFinite)

      return {
        id: node.name as string,
        name: node.description || (node.name as string),
        isDefault: node.name === defaultName.trim(),
        volume: levels.length ? Math.round(levels.reduce((sum, value) => sum + value, 0) / levels.length) : 0,
        muted: Boolean(node.mute)
      }
    })
}

interface NiriOutput {
  name?: string
  make?: string
  model?: string
  modes?: { width: number; height: number; refresh_rate: number }[]
  current_mode?: number | null
  logical?: { scale?: number } | null
}

/** `niri msg --json outputs`: an object keyed by connector name. */
export function parseNiriOutputs(stdout: string): DisplayInfo[] {
  let outputs: Record<string, NiriOutput>

  try {
    outputs = JSON.parse(stdout) as Record<string, NiriOutput>
  } catch {
    return []
  }

  return Object.entries(outputs ?? {})
    .map(([name, output]) => {
      const modes: DisplayMode[] = (output.modes ?? []).map(mode => ({ width: mode.width, height: mode.height, refresh: Math.round(mode.refresh_rate / 10) / 100 }))
      const current = typeof output.current_mode === 'number' ? modes[output.current_mode] : undefined
      const label = [output.make, output.model].filter(part => part && part !== 'Unknown').join(' ') || name

      return { name, label, enabled: Boolean(current), width: current?.width ?? 0, height: current?.height ?? 0, refresh: current?.refresh ?? 0, scale: output.logical?.scale ?? 1, modes }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** `brightnessctl -m --class=backlight`: "device,class,current,percent%,max". */
export function parseBrightness(stdout: string): number | undefined {
  const percent = stdout.split('\n')[0]?.split(',')[3]

  return percent ? Number(percent.replace('%', '')) : undefined
}

/** `powerprofilesctl list`: profile names, the active one starred. */
export function parsePowerProfiles(stdout: string): { profiles: string[]; active?: string } {
  const profiles: string[] = []
  let active: string | undefined

  for (const line of stdout.split('\n')) {
    const match = /^(\*)?\s*([a-z][a-z-]*):\s*$/.exec(line)

    if (match) {
      profiles.push(match[2])

      if (match[1]) {
        active = match[2]
      }
    }
  }

  return { profiles, active }
}

/** `upower -i <battery>`: "time to empty: 3.2 hours" -> "about 3.2 hours left". */
export function parseUpowerTime(stdout: string): string | undefined {
  const empty = /time to empty:\s*(.+)/i.exec(stdout)?.[1]?.trim()
  const full = /time to full:\s*(.+)/i.exec(stdout)?.[1]?.trim()

  return empty ? `about ${empty} left` : full ? `full in about ${full}` : undefined
}

/** niri output settings as KDL, for outputs.kdl. */
export function renderOutputs(displays: readonly DisplayInfo[]): string {
  const blocks = displays.map(display => {
    const lines = display.enabled ? [`    mode "${display.width}x${display.height}@${display.refresh.toFixed(3)}"`, `    scale ${display.scale}`] : ['    off']

    return `output "${display.name}" {\n${lines.join('\n')}\n}`
  })

  return `// Written by the Veritas OS Display panel. Put your own output settings in local.kdl.\n${blocks.join('\n')}\n`
}

// ---- Commands -----------------------------------------------------------------------------------

async function must(command: string, args: string[], needs: string, timeoutMs = 15_000): Promise<string> {
  const result = await run(command, args, timeoutMs)

  if (result.code === MISSING_BINARY) {
    throw new HostNotSupported(`${command}`, needs)
  }

  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `${command} ${args[0] ?? ''} failed`)
  }

  return result.stdout
}

async function wifiState(rescan: boolean): Promise<WifiState> {
  const radio = await run('nmcli', ['-t', '-f', 'WIFI', 'general'], 8000)

  if (radio.code === MISSING_BINARY) {
    return { available: false, enabled: false, networks: [] }
  }

  const enabled = radio.stdout.trim() === 'enabled'

  if (!enabled) {
    return { available: true, enabled, networks: [] }
  }

  const [list, saved] = await Promise.all([
    run('nmcli', ['-t', '-f', 'IN-USE,SSID,SIGNAL,SECURITY', 'device', 'wifi', 'list', '--rescan', rescan ? 'yes' : 'auto'], 20_000),
    run('nmcli', ['-t', '-f', 'NAME,TYPE', 'connection', 'show'], 8000)
  ])
  const networks = parseWifiList(list.stdout, parseKnownWifi(saved.stdout))

  // No Wi-Fi device at all (a wired desktop, a VM) shows up as an empty list with an error.
  return { available: list.code === 0 || networks.length > 0, enabled, connected: networks.find(network => network.active)?.ssid, networks }
}

async function wifiDevice(): Promise<string | undefined> {
  const devices = await run('nmcli', ['-t', '-f', 'DEVICE,TYPE', 'device'], 8000)

  return devices.stdout
    .split('\n')
    .map(splitTerse)
    .find(([, type]) => type === 'wifi')?.[0]
}

async function bluetoothState(): Promise<BluetoothState> {
  const show = await run('bluetoothctl', ['show'], 8000)

  if (show.code === MISSING_BINARY) {
    return { available: false, powered: false, devices: [] }
  }

  const adapter = parseBluetoothShow(show.stdout)

  if (!adapter.present) {
    return { available: false, powered: false, devices: [] }
  }

  const listed = parseBluetoothDevices((await run('bluetoothctl', ['devices'], 8000)).stdout).slice(0, 40)
  const devices = await Promise.all(listed.map(async device => ({ ...device, ...parseBluetoothInfo((await run('bluetoothctl', ['info', device.address], 8000)).stdout) })))

  return { available: true, powered: adapter.powered, devices: devices.sort((a, b) => Number(b.connected) - Number(a.connected) || Number(b.paired) - Number(a.paired) || a.name.localeCompare(b.name)) }
}

async function audioState(): Promise<AudioState> {
  const sinks = await run('pactl', ['-f', 'json', 'list', 'sinks'], 8000)

  if (sinks.code === MISSING_BINARY) {
    return { available: false, outputs: [], inputs: [] }
  }

  const [sources, defaultSink, defaultSource] = await Promise.all([run('pactl', ['-f', 'json', 'list', 'sources'], 8000), run('pactl', ['get-default-sink'], 5000), run('pactl', ['get-default-source'], 5000)])

  return { available: true, outputs: parsePactl(sinks.stdout, defaultSink.stdout), inputs: parsePactl(sources.stdout, defaultSource.stdout) }
}

const NIRI_OUTPUTS = () => path.join(os.homedir(), '.config', 'niri', 'outputs.kdl')

async function displayState(): Promise<DisplayState> {
  const [outputs, backlight] = await Promise.all([run('niri', ['msg', '--json', 'outputs'], 8000), run('brightnessctl', ['-m', '--class=backlight'], 5000)])
  const displays = outputs.code === 0 ? parseNiriOutputs(outputs.stdout) : []

  return { available: displays.length > 0, displays, brightness: backlight.code === 0 ? parseBrightness(backlight.stdout) : undefined }
}

/** Display changes apply at once through niri and are kept in outputs.kdl for the next session. */
async function persistOutputs(): Promise<void> {
  const { displays } = await displayState()

  if (displays.length > 0) {
    fs.mkdirSync(path.dirname(NIRI_OUTPUTS()), { recursive: true })
    fs.writeFileSync(NIRI_OUTPUTS(), renderOutputs(displays))
  }
}

async function powerState(stats: SystemStats): Promise<PowerState> {
  const [profiles, devices] = await Promise.all([run('powerprofilesctl', ['list'], 5000), run('upower', ['-e'], 5000)])
  const parsed = profiles.code === 0 ? parsePowerProfiles(profiles.stdout) : { profiles: [], active: undefined }
  const battery = devices.stdout.split('\n').find(line => /battery_/i.test(line))?.trim()
  const timeRemaining = battery ? parseUpowerTime((await run('upower', ['-i', battery], 5000)).stdout) : undefined

  return { available: true, battery: stats.battery, timeRemaining, profile: parsed.active, profiles: parsed.profiles }
}

export async function linuxControlStatus(panel: StatusPanelId, stats: () => Promise<SystemStats>): Promise<StatusPanelState> {
  switch (panel) {
    case 'wifi':
      return { panel, wifi: await wifiState(false) }
    case 'bluetooth':
      return { panel, bluetooth: await bluetoothState() }
    case 'audio':
      return { panel, audio: await audioState() }
    case 'display':
      return { panel, display: await displayState() }
    case 'power':
      return { panel, power: await powerState(await stats()) }
    default:
      throw new Error(`no status for the ${panel} panel`)
  }
}

export async function linuxControlAction(action: ControlAction): Promise<void> {
  switch (action.panel) {
    case 'wifi': {
      const needs = 'NetworkManager (nmcli)'

      if (action.action === 'enable') {
        await must('nmcli', ['radio', 'wifi', action.enabled ? 'on' : 'off'], needs)
      } else if (action.action === 'scan') {
        await run('nmcli', ['device', 'wifi', 'rescan'], 15_000)
      } else if (action.action === 'connect') {
        // nmcli takes the password as an argument; it is visible to this user's own processes only briefly.
        await must('nmcli', ['device', 'wifi', 'connect', action.ssid, ...(action.password ? ['password', action.password] : [])], needs, 45_000)
      } else if (action.action === 'disconnect') {
        const device = await wifiDevice()

        if (device) {
          await must('nmcli', ['device', 'disconnect', device], needs)
        }
      } else {
        await must('nmcli', ['connection', 'delete', 'id', action.ssid], needs)
      }

      return
    }
    case 'bluetooth': {
      const needs = 'BlueZ (bluetoothctl)'

      if (action.action === 'power') {
        await must('bluetoothctl', ['power', action.enabled ? 'on' : 'off'], needs)
      } else if (action.action === 'scan') {
        await run('bluetoothctl', ['--timeout', '8', 'scan', 'on'], 15_000)
      } else if (action.action === 'pair') {
        await must('bluetoothctl', ['pair', action.address], needs, 40_000)
        await run('bluetoothctl', ['trust', action.address], 8000)
        await run('bluetoothctl', ['connect', action.address], 30_000)
      } else {
        await must('bluetoothctl', [action.action, action.address], needs, 30_000)
      }

      return
    }
    case 'audio': {
      const needs = 'pulseaudio-utils (pactl)'
      const kind = action.kind === 'output' ? 'sink' : 'source'

      if (action.action === 'default') {
        await must('pactl', [`set-default-${kind}`, action.id], needs)
      } else {
        const target = action.id ?? `@DEFAULT_${kind.toUpperCase()}@`

        if (action.percent !== undefined) {
          await must('pactl', [`set-${kind}-volume`, target, `${Math.max(0, Math.min(150, Math.round(action.percent)))}%`], needs)
        }

        if (action.muted !== undefined) {
          await must('pactl', [`set-${kind}-mute`, target, action.muted ? '1' : '0'], needs)
        }
      }

      return
    }
    case 'display': {
      if (action.action === 'brightness') {
        await must('brightnessctl', ['--class=backlight', 'set', `${Math.max(1, Math.min(100, Math.round(action.percent)))}%`], 'brightnessctl')

        return
      }

      const args = action.action === 'scale' ? [String(action.scale)] : action.action === 'mode' ? ['mode', `${action.mode.width}x${action.mode.height}@${action.mode.refresh}`] : [action.enabled ? 'on' : 'off']
      await must('niri', ['msg', 'output', action.name, ...(action.action === 'scale' ? ['scale', ...args] : args)], 'niri')
      await persistOutputs()

      return
    }
    case 'power':
      await must('powerprofilesctl', ['set', action.profile], 'power-profiles-daemon (powerprofilesctl)')

      return
  }
}
