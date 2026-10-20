import { IconBrandTelegram, IconRefresh, IconSend, IconSettings, IconTerminal2 } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import { GlassButton, GlassCard, PageHeader, Pill, Toggle } from '../../components/ui/glass.tsx'
import type { VeritasEntry, VeritasStatus } from '../../../shared/ipc.ts'
import { notify } from '../../store/notifications.ts'
import { showPage } from '../../store/windows.ts'
import { cn } from '../../lib/cn.ts'
import { FieldLabel, Hint, TextInput } from '../automations/presentation.tsx'

/*
 * Veritas: OpenCode as the operator of the whole OS. The conversation is shared with Telegram and
 * kept on disk, so the page always shows the same thread the agent remembers.
 */

export function VeritasPage() {
  const [status, setStatus] = useState<VeritasStatus | null>(null)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [showSetup, setShowSetup] = useState(false)
  const transcriptRef = useRef<HTMLDivElement>(null)

  const transcript = status?.transcript ?? []

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
      await window.heraldOS.veritas.ask(text)
    } catch (error) {
      notify({ title: 'Veritas could not answer', body: error instanceof Error ? error.message : String(error), level: 'error' })
    } finally {
      setBusy(false)
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
          <span className="truncate" title="The agent's persistent session — this is its memory">
            session {status?.sessionId ?? '…'}
          </span>
          {status?.lastError ? <span className="truncate text-danger">· {status.lastError}</span> : null}
        </div>

        {/* The shared conversation */}
        <GlassCard className="flex min-h-0 flex-1 flex-col overflow-hidden p-0">
          <div ref={transcriptRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3 font-mono text-[13px] leading-relaxed">
            {transcript.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-fg-4">
                <IconTerminal2 size={28} stroke={1.4} />
                <div className="text-[13px] text-fg-3">Ask Veritas anything — it runs it on this machine.</div>
                <div className="text-[12px] text-fg-4">“what agents are running?” · “open Firefox” · “remember my wifi is ThunderNet”</div>
              </div>
            ) : (
              transcript.map((entry, index) => <Entry key={`${entry.ts}-${index}`} entry={entry} />)
            )}
            {busy ? <div className="text-fg-4">▍Veritas is working…</div> : null}
          </div>

          <div className="flex items-end gap-2 border-t border-line p-3">
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
              placeholder={busy ? 'Veritas is working…' : 'Ask Veritas…'}
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
        {fromTelegram ? <span className="inline-flex items-center gap-0.5"><IconBrandTelegram size={10} />telegram</span> : null}
      </div>
      <div className={cn('text-fg', entry.role === 'user' && 'text-fg-2')}>{entry.text}</div>
    </div>
  )
}

function TelegramSetup({ status }: { status: VeritasStatus }) {
  const [botToken, setBotToken] = useState('')
  const [chatIds, setChatIds] = useState(status.allowedChatIds.join(', '))
  const [enabled, setEnabled] = useState(status.telegramEnabled)
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

      await window.heraldOS.veritas.configure({ telegram })
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
          <div className="text-[14px] font-semibold text-fg">Telegram</div>
          <div className="text-[12px] text-fg-3">Reach Veritas from your phone. Get a token from @BotFather, your chat id from @userinfobot. A blank token keeps the current one.</div>
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
