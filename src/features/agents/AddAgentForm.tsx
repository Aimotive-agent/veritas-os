import { IconPlus, IconPlug, IconX } from '@tabler/icons-react'
import { useState } from 'react'
import { GlassButton, GlassCard, Toggle } from '../../components/ui/glass.tsx'
import { notify } from '../../store/notifications.ts'
import type { AgentSpec } from '../../../shared/ipc.ts'
import { FieldLabel, Hint, TextInput } from '../automations/presentation.tsx'

/*
 * Inline "Add agent" form. Writes a spec through the shell (which persists it to
 * ~/.config/veritas-os/agents.json and registers it live — no restart needed).
 */

/** Split a command line into argv, honouring single and double quotes. */
function splitArgv(line: string): string[] {
  const args: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match: RegExpExecArray | null

  while ((match = re.exec(line)) != null) {
    args.push(match[1] ?? match[2] ?? match[3])
  }

  return args
}

export function AddAgentForm({ onDone }: { onDone: () => void }) {
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [kind, setKind] = useState('')
  const [command, setCommand] = useState('')
  const [readyUrl, setReadyUrl] = useState('')
  const [embedUrl, setEmbedUrl] = useState('')
  const [pairCommand, setPairCommand] = useState('')
  const [runCommand, setRunCommand] = useState('')
  const [defaultEnabled, setDefaultEnabled] = useState(false)
  const [saving, setSaving] = useState(false)

  const canCreate = id.trim().length > 0 && splitArgv(command).length > 0 && !saving

  const submit = async () => {
    if (!canCreate) {
      return
    }

    const spec: AgentSpec = {
      id: id.trim(),
      name: name.trim() || id.trim(),
      kind: kind.trim() || 'custom',
      command: splitArgv(command),
      readyUrl: readyUrl.trim() || 'http://127.0.0.1:{port}/'
    }
    const pair = splitArgv(pairCommand)
    const run = splitArgv(runCommand)

    if (embedUrl.trim()) spec.embedUrl = embedUrl.trim()
    if (pair.length) spec.pairCommand = pair
    if (run.length) spec.runCommand = run
    if (defaultEnabled) spec.defaultEnabled = true

    setSaving(true)
    try {
      await window.heraldOS.agents.add(spec)
      notify({ title: 'Agent added', body: `${spec.name} is ready to run.`, level: 'success' })
      onDone()
    } catch (error) {
      notify({ title: 'Could not add agent', body: error instanceof Error ? error.message : String(error), level: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <GlassCard className="flex min-h-0 flex-col">
      <div className="flex items-start gap-3.5 px-5 pt-5 pb-4">
        <div className="icon-tile grid size-11 shrink-0 place-items-center">
          <IconPlug size={22} stroke={1.7} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-[16px] leading-tight font-semibold text-fg">Add an agent</h2>
          <p className="mt-1 text-[12.5px] text-fg-3">
            Any local program with an HTTP endpoint. It shows up in the sidebar, hub and mission picker.
          </p>
        </div>
        <GlassButton size="icon" variant="ghost" onClick={onDone} aria-label="Close add agent form" className="-mt-1 -mr-2">
          <IconX />
        </GlassButton>
      </div>

      <form
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-4"
        onSubmit={event => {
          event.preventDefault()
          void submit()
        }}
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <FieldLabel htmlFor="add-agent-id">Id</FieldLabel>
            <TextInput id="add-agent-id" value={id} onChange={e => setId(e.target.value)} placeholder="my-agent" autoFocus />
            <Hint>Lowercase letters, digits and dashes. Used in the config file.</Hint>
          </div>
          <div className="flex flex-col gap-1.5">
            <FieldLabel htmlFor="add-agent-name">Name</FieldLabel>
            <TextInput id="add-agent-name" value={name} onChange={e => setName(e.target.value)} placeholder="My Agent" />
            <Hint>Defaults to the id.</Hint>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor="add-agent-command">Command</FieldLabel>
          <TextInput id="add-agent-command" value={command} onChange={e => setCommand(e.target.value)} placeholder='my-agent serve --port {port}' required />
          <Hint>
            The program to run. <code className="text-accent-strong">{'{port}'}</code> is replaced with a free port.
          </Hint>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <FieldLabel htmlFor="add-agent-kind">Kind (optional)</FieldLabel>
            <TextInput id="add-agent-kind" value={kind} onChange={e => setKind(e.target.value)} placeholder="custom" />
          </div>
          <div className="flex flex-col gap-1.5">
            <FieldLabel htmlFor="add-agent-ready">Health URL</FieldLabel>
            <TextInput id="add-agent-ready" value={readyUrl} onChange={e => setReadyUrl(e.target.value)} placeholder="http://127.0.0.1:{port}/health" />
            <Hint>Polled until it answers; any sub-400 response means ready.</Hint>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor="add-agent-embed">Web UI URL (optional)</FieldLabel>
          <TextInput id="add-agent-embed" value={embedUrl} onChange={e => setEmbedUrl(e.target.value)} placeholder="http://127.0.0.1:{port}/" />
          <Hint>Embedded in a Veritas OS window when the agent is ready.</Hint>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <FieldLabel htmlFor="add-agent-pair">Pair command (optional)</FieldLabel>
            <TextInput id="add-agent-pair" value={pairCommand} onChange={e => setPairCommand(e.target.value)} placeholder="my-agent pair" />
            <Hint>Prints one-time links; a Pair button appears when set.</Hint>
          </div>
          <div className="flex flex-col gap-1.5">
            <FieldLabel htmlFor="add-agent-run">Run command (optional)</FieldLabel>
            <TextInput id="add-agent-run" value={runCommand} onChange={e => setRunCommand(e.target.value)} placeholder='my-agent run "{goal}"' />
            <Hint>
              How it runs a mission; <code className="text-accent-strong">{'{goal}'}</code> is the mission text.
            </Hint>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-white/4 px-3.5 py-2.5">
          <div className="min-w-0">
            <div className="text-[13px] text-fg">Start automatically</div>
            <div className="text-[12px] text-fg-3">Launch this agent whenever Veritas OS starts.</div>
          </div>
          <Toggle checked={defaultEnabled} onChange={setDefaultEnabled} label="Start automatically" />
        </div>
      </form>

      <div className="flex items-center justify-end gap-3 border-t border-line px-5 py-3.5">
        <GlassButton variant="ghost" onClick={onDone}>
          Cancel
        </GlassButton>
        <GlassButton variant="primary" disabled={!canCreate} onClick={() => void submit()} aria-label="Add agent">
          <IconPlus />
          {saving ? 'Adding…' : 'Add agent'}
        </GlassButton>
      </div>
    </GlassCard>
  )
}
