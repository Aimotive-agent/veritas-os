import { ipcMain } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { type AuditEntry, IPC } from '../../shared/ipc.ts'
import { heraldOsDataDir } from '../paths.ts'

const DEFAULT_POLICY = `# Veritas OS system bridge policy. See docs/SYSTEM-BRIDGE.md.
version: 1
tiers:
  read: allow
  act: allow
  mutate: confirm
  destructive: confirm
protected_paths: []
`

/** The policy file and audit log the herald-os-bridge plugin reads and writes. */
export function registerBridgeIpc(): void {
  const policyFile = () => path.join(heraldOsDataDir(), 'permissions.yaml')
  const auditFile = () => path.join(heraldOsDataDir(), 'audit.jsonl')

  ipcMain.handle(IPC.bridgePolicyRead, async () => {
    try {
      return await fs.readFile(policyFile(), 'utf8')
    } catch {
      return DEFAULT_POLICY
    }
  })
  ipcMain.handle(IPC.bridgePolicyWrite, async (_event, text: string) => {
    await fs.mkdir(heraldOsDataDir(), { recursive: true })
    await fs.writeFile(policyFile(), String(text))
  })
  ipcMain.handle(IPC.bridgeAuditRead, async (_event, limit: number): Promise<AuditEntry[]> => {
    let text = ''

    try {
      text = await fs.readFile(auditFile(), 'utf8')
    } catch {
      return []
    }

    const lines = text.trim().split('\n').filter(Boolean)
    const entries: AuditEntry[] = []

    for (const line of lines.slice(-Math.max(1, Math.min(1000, limit || 200)))) {
      try {
        entries.push(JSON.parse(line) as AuditEntry)
      } catch {
        // Skip a torn line.
      }
    }

    return entries.reverse()
  })
}
