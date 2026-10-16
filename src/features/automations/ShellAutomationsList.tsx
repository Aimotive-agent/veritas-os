import { IconBolt, IconPlayerPlay, IconRefresh, IconTrash } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import type { ShellAutomation } from '../../../shared/ipc.ts'
import { EmptyGlass, GlassButton, Pill, StatusDot } from '../../components/ui/glass.tsx'
import { cn } from '../../lib/cn.ts'
import { notify } from '../../store/notifications.ts'

/**
 * Automations the shell owns because they run on an agent other than Hermes. Hermes' own cron owns
 * its jobs; these live in ~/.config/veritas-os/automations.json, and the shell hands the prompt to
 * the chosen agent when the schedule fires.
 */
export function ShellAutomationsList() {
  const [automations, setAutomations] = useState<ShellAutomation[]>([])
  const [busy, setBusy] = useState<string | null>(null)

  const load = () => {
    void window.heraldOS.shellAutomations.list().then(setAutomations)
  }

  useEffect(() => {
    load()

    return window.heraldOS.shellAutomations.onChanged(setAutomations)
  }, [])

  const act = async (id: string, what: 'run' | 'remove' | 'toggle', automation?: ShellAutomation) => {
    setBusy(id)

    try {
      if (what === 'run') {
        setAutomations(await window.heraldOS.shellAutomations.run(id))
        notify({ title: 'Automation ran', level: 'success' })
      } else if (what === 'remove') {
        setAutomations(await window.heraldOS.shellAutomations.remove(id))
      } else if (automation) {
        setAutomations(await window.heraldOS.shellAutomations.update(id, { enabled: !automation.enabled }))
      }
    } catch (error) {
      notify({ title: 'Automation action failed', body: error instanceof Error ? error.message : String(error), level: 'error' })
    } finally {
      setBusy(null)
    }
  }

  if (!automations.length) {
    return (
      <EmptyGlass
        icon={<IconBolt />}
        title="No shell automations"
        description="Create one and choose an agent other than Hermes — the shell schedules it and hands it over."
      />
    )
  }

  return (
    <ul className="flex flex-col gap-2">
      {automations.map(automation => (
        <li key={automation.id} className="glass-card flex items-center gap-3 rounded-lg px-3 py-2.5">
          <StatusDot tone={automation.enabled ? 'ok' : 'muted'} pulse={false} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className={cn('truncate text-[13px] font-medium', automation.enabled ? 'text-fg' : 'text-fg-3')}>{automation.name}</span>
              <Pill tone="accent">{automation.agentId}</Pill>
              <span className="shrink-0 font-mono text-[11px] text-fg-3">{automation.schedule}</span>
            </div>
            <div className="truncate text-[11.5px] text-fg-3" title={automation.prompt}>
              {automation.prompt}
            </div>
            <div className="mt-0.5 text-[11px] text-fg-4">
              {automation.runCount ? `ran ${automation.runCount}×` : 'never run'}
              {automation.lastError ? <span className="text-danger"> · last error: {automation.lastError}</span> : null}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <GlassButton size="sm" variant="secondary" disabled={busy === automation.id} onClick={() => void act(automation.id, 'run')}>
              <IconPlayerPlay /> Run
            </GlassButton>
            <GlassButton size="sm" variant="ghost" onClick={() => void act(automation.id, 'toggle', automation)}>
              <IconRefresh /> {automation.enabled ? 'Pause' : 'Resume'}
            </GlassButton>
            <GlassButton size="sm" variant="ghost" aria-label="Delete" onClick={() => void act(automation.id, 'remove')}>
              <IconTrash />
            </GlassButton>
          </div>
        </li>
      ))}
    </ul>
  )
}
