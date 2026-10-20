import { IconBrandTelegram, IconFolder, IconPaperclip, IconPlus, IconSend, IconSettings, IconTerminal2, IconTrash } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import { GlassButton, GlassCard, PageHeader, Pill, Toggle } from '../../components/ui/glass.tsx'
import type { VeritasEntry, VeritasStatus } from '../../../shared/ipc.ts'
import { notify } from '../../store/notifications.ts'
import { showPage } from '../../store/windows.ts'
import { cn } from '../../lib/cn.ts'
import { FieldLabel, Hint, TextInput } from '../automations/presentation.tsx'

/*
 * Veritas: OpenCode as the operator of the whole OS. Work happens in projects - each has its own
 * folder, its own session and therefore its own memory - and the conversation is shared with
 * Telegram and kept on disk.
 */

export function VeritasPage() {
  const [status, setStatus] = useState<VeritasStatus | null>(null)
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [showSetup, setShowSetup] = useState(false)
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [newPath, setNewPath] = useState('')
  const transcriptRef = useRef<HTMLDivElement>(null)

  const projects = status?.projects ?? []
  const currentProject = status?.currentProject ?? ''
  const transcript = (status?.transcript ?? []).filter(entry => !entry.projectId || entry.projectId === currentProject)

  useEffect(() => {
    void window.heraldOS.veritas.status().then(setStatus)
    return window.heraldOS.veritas.onChanged(setStatus)
  }, [])

  useEffect(() => {
    const el = transcriptRef.current

    if (el) {
      el.scrollTop = el.scrollHeight
    }
  }, [transcript.length, busy])

  const send = async () => {
    const text = input.trim()

    if (!text || busy) {
      return
    }

    setInput('')
    setBusy(true)

    try {
      // The agent records both sides of the exchange, so we do not add it here.
      await window.heraldOS.veritas.ask(text, attachments)
      setAttachments([])
    } catch (error) {
      notify({ title: 'Veritas could not answer', body: error instanceof Error ? error.message : String(error), level: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const attach = async () => {
    try {
      const picked = await window.heraldOS.fs.pickFiles({ multiple: true })
      if (picked.length) {
        setAttachments(current => [...current, ...picked.filter(file => !current.includes(file))])
      }
    } catch (error) {
      notify({ title: 'Could not attach files', body: error instanceof Error ? error.message : String(error), level: 'error' })
    }
  }

  const pickFolder = async () => {
    try {
      const picked = await window.heraldOS.fs.pickFiles({ directory: true })
      if (picked[0]) {
        setNewPath(picked[0])
      }
    } catch (error) {
      notify({ title: 'Could not pick a folder', body: error instanceof Error ? error.message : String(error), level: 'error' })
    }
  }

  const addProject = async () => {
    if (!newName.trim()) {
      return
    }

    setBusy(true)
    try {
      await window.heraldOS.veritas.configure({ addProject: { name: newName.trim(), path: newPath.trim() } })
      setNewName('')
      setNewPath('')
      setAdding(false)
    } catch (error) {
      notify({ title: 'Could not add the project', body: error instanceof Error ? error.message : String(error), level: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const removeProject = async (id: string) => {
    try {
      await window.heraldOS.veritas.configure({ removeProject: id })
    } catch (error) {
      notify({ title: 'Could not remove the project', body: error instanceof Error ? error.message : String(error), level: 'error' })
    }
  }

  return (
    <div className="page-enter flex h-full flex-col">
      <PageHeader
        icon="terminal"
        title="Veritas"
        subtitle="OpenCode, operating every agent and app on this laptop."
        actions={
          <>
            <GlassButton variant="ghost" onClick={() => setShowSetup(current => !current)}>
              <IconSettings /> {showSetup ? 'Hide setup' : 'Setup'}
            </GlassButton>
            <GlassButton variant="primary" onClick={() => showPage('agent:opencode')}>
              <IconTerminal2 /> Open OpenCode
            </GlassButton>
          </>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 pb-6">
        {/* Projects */}
        <div className="flex items-center gap-2 overflow-x-auto">
          {projects.map(project => {
            const active = project.id === currentProject

            return (
              <div key={project.id} className="group flex items-center">
                <button
                  type="button"
                  onClick={() => void window.heraldOS.veritas.configure({ currentProject: project.id })}
                  aria-pressed={active}
                  title={project.path}
                  className={cn(
                    'flex h-7 items-center gap-1.5 rounded-l-full border border-r-0 px-3 text-[12.5px] transition-colors',
                    active ? 'bg-accent text-accent-fg' : 'border-line bg-white/4 text-fg-2 hover:bg-white/8'
                  )}
                >
                  <IconFolder size={13} />
                  {project.name}
                </button>
                {projects.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => void removeProject(project.id)}
                    aria-label={`Remove ${project.name}`}
                    className={cn(
                      'flex h-7 items-center rounded-r-full border px-1.5 transition-colors',
                      active ? 'border-accent bg-accent text-accent-fg' : 'border-line bg-white/4 text-fg-3 hover:text-danger'
                    )}
                  >
                    <IconTrash size={12} />
                  </button>
                ) : null}
              </div>
            )
          })}
          {adding ? (
            <div className="flex h-7 items-center gap-1.5 rounded-full border border-line bg-white/4 px-2">
              <TextInput value={newName} onChange={e => setNewName(e.target.value)} placeholder="Project name" className="h-6 w-36 !text-[12px]" />
              <button type="button" onClick={() => void pickFolder()} className="flex items-center gap-1 text-[12px] text-fg-3 hover:text-fg">
                <IconFolder size={13} /> {newPath ? newPath.split('/').filter(Boolean).pop() : 'folder'}
              </button>
              <GlassButton size="sm" variant="primary" disabled={!newName.trim()} onClick={() => void addProject()}>Add</GlassButton>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-line bg-white/4 text-fg-3 hover:bg-white/8 hover:text-fg"
              aria-label="Add a project"
            >
              <IconPlus size={14} />
            </button>
          )}
        </div>

        {/* Status strip */}
        <div className="flex items-center gap-3 text-[12px] text-fg-3">
          <span className="inline-flex items-center gap-1.5">
            <span className={`size-1.5 rounded-full ${status?.busy || busy ? 'bg-warn animate-pulse-soft' : 'bg-ok'}`} />
            {busy ? 'Working…' : 'Ready'}
          </span>
          <span>·</span>
          <span className="inline-flex items-center gap-1.5">
            <IconBrandTelegram size={14} />
            {status?.telegramEnabled ? 'Telegram on' : 'Telegram off'}
          </span>
          <span>·</span>
          <span className="truncate" title="The model this project runs on">
            {status?.model ?? '…'}
          </span>
          {status?.lastError ? <span className="truncate text-danger">· {status.lastError}</span> : null}
        </div>

        {/* The shared conversation */}
        <GlassCard className="flex min-h-0 flex-1 flex-col overflow-hidden p-0">
          <div ref={transcriptRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3 font-mono text-[13px] leading-relaxed">
            {transcript.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-fg-4">
                <IconTerminal2 size={28} stroke={1.4} />
                <div className="text-[13px] text-fg-3">Ask Veritas anything in this project — it runs it on this machine.</div>
                <div className="text-[12px] text-fg-4">“what agents are running?” · “open Firefox” · “remember my wifi is ThunderNet”</div>
              </div>
            ) : (
              transcript.map((entry, index) => <Entry key={`${entry.ts}-${index}`} entry={entry} />)
            )}
            {busy ? <div className="text-fg-4">▍Veritas is working…</div> : null}
          </div>

          {attachments.length ? (
            <div className="flex flex-wrap gap-1.5 border-t border-line px-3 pt-2">
              {attachments.map(file => (
                <span key={file} className="flex h-6 items-center gap-1.5 rounded-full border border-line bg-white/6 pr-1.5 pl-2 text-[11.5px] text-fg-2">
                  {file.split('/').pop()}
                  <button
                    type="button"
                    onClick={() => setAttachments(current => current.filter(item => item !== file))}
                    aria-label={`Remove ${file}`}
                    className="text-fg-4 hover:text-danger"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : null}

          <div className="flex items-end gap-2 border-t border-line p-3">
            <GlassButton variant="ghost" size="icon" onClick={() => void attach()} aria-label="Attach files" disabled={busy}>
              <IconPaperclip />
            </GlassButton>
            <span className="pb-2 font-mono text-[14px] text-accent-strong">›</span>
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
              rows={1}
              placeholder={busy ? 'Veritas is working…' : `Ask Veritas in ${projects.find(p => p.id === currentProject)?.name ?? 'this project'}…`}
              className="glass-input min-w-0 flex-1 resize-none rounded-lg px-3 py-2 font-mono text-[13px] leading-relaxed text-fg outline-none placeholder:text-fg-4"
            />
            <GlassButton variant="primary" disabled={!input.trim() || busy} onClick={() => void send()} aria-label="Send to Veritas">
              <IconSend />
            </GlassButton>
          </div>
        </GlassCard>

        {showSetup && status ? <TelegramSetup status={status} /> : null}
      </div>
    </div>
  )
}

function Entry({ entry }: { entry: VeritasEntry }) {
  const fromTelegram = entry.source === 'telegram'

  return (
    <div className="mb-3 whitespace-pre-wrap break-words">
      <div className="mb-0.5 flex items-center gap-2 text-[10.5px] tracking-wide text-fg-4 uppercase">
        <span className={entry.role === 'user' ? 'text-accent-strong' : 'text-fg-3'}>{entry.role === 'user' ? 'you' : 'veritas'}</span>
        {fromTelegram ? (
          <span className="inline-flex items-center gap-0.5">
            <IconBrandTelegram size={10} />telegram
          </span>
        ) : null}
      </div>
      <div className={cn('text-fg', entry.role === 'user' && 'text-fg-2')}>{entry.text}</div>
    </div>
  )
}

function TelegramSetup({ status }: { status: VeritasStatus }) {
  const [botToken, setBotToken] = useState('')
  const [chatIds, setChatIds] = useState(status.allowedChatIds.join(', '))
  const [enabled, setEnabled] = useState(status.telegramEnabled)
  const [model, setModel] = useState(status.model)
  const [visionModel, setVisionModel] = useState(status.visionModel)
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setSaving(true)
    try {
      const telegram: { allowedChatIds: number[]; enabled: boolean; botToken?: string } = {
        allowedChatIds: chatIds.split(/[\s,]+/).map(part => Number(part.trim())).filter(n => Number.isInteger(n) && n > 0),
        enabled
      }

      if (botToken.trim()) {
        telegram.botToken = botToken.trim()
      }

      await window.heraldOS.veritas.configure({ telegram, model: model.trim(), visionModel: visionModel.trim() })
      notify({ title: 'Veritas updated', level: 'success' })
    } catch (error) {
      notify({ title: 'Could not save', body: error instanceof Error ? error.message : String(error), level: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <GlassCard className="flex shrink-0 flex-col">
      <div className="flex items-center gap-3 px-5 pt-4 pb-3">
        <IconBrandTelegram size={18} className="shrink-0 text-[#37aee2]" />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold text-fg">Telegram &amp; models</div>
          <div className="text-[12px] text-fg-3">Reach Veritas from your phone. Get a token from @BotFather, your chat id from @userinfobot.</div>
        </div>
        <Pill tone={status.telegramEnabled ? 'ok' : 'muted'}>{status.telegramEnabled ? 'On' : 'Off'}</Pill>
      </div>
      <div className="flex flex-col gap-3 px-5 pb-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <FieldLabel htmlFor="veritas-bot">Bot token</FieldLabel>
            <TextInput id="veritas-bot" type="password" value={botToken} onChange={e => setBotToken(e.target.value)} placeholder="123:abc…" />
          </div>
          <div className="flex flex-col gap-1.5">
            <FieldLabel htmlFor="veritas-chatids">Your chat id(s)</FieldLabel>
            <TextInput id="veritas-chatids" value={chatIds} onChange={e => setChatIds(e.target.value)} placeholder="123456789" />
            <Hint>Only these ids can talk to Veritas.</Hint>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <FieldLabel htmlFor="veritas-model">Model</FieldLabel>
            <TextInput id="veritas-model" value={model} onChange={e => setModel(e.target.value)} placeholder="deepseek/deepseek-v4-pro" />
            <Hint>Used for everything unless an image is attached.</Hint>
          </div>
          <div className="flex flex-col gap-1.5">
            <FieldLabel htmlFor="veritas-vision">Vision model</FieldLabel>
            <TextInput id="veritas-vision" value={visionModel} onChange={e => setVisionModel(e.target.value)} placeholder="omniroute/auto/best-vision" />
            <Hint>Used automatically when you attach an image.</Hint>
          </div>
        </div>
        <div className="flex items-center justify-between gap-3">
          <div className="text-[13px] text-fg">Enable Telegram</div>
          <div className="flex items-center gap-3">
            <Toggle checked={enabled} onChange={setEnabled} label="Enable Telegram" />
            <GlassButton variant="primary" size="sm" disabled={saving} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save'}
            </GlassButton>
          </div>
        </div>
      </div>
    </GlassCard>
  )
}
