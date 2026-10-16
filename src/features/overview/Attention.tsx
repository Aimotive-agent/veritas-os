import { useStore } from '@nanostores/react'
import { IconArrowRight, IconEye, IconKey, IconMessageQuestion, IconShieldCheck } from '@tabler/icons-react'
import { GlassButton, GlassCard, Section } from '../../components/ui/glass.tsx'
import { openStoredSession } from '../../store/chat.ts'
import { $reviewMissions, markReviewed } from '../../store/missions.ts'
import { $pendingRequests, type PendingRequest } from '../../store/requests.ts'
import { showPage } from '../../store/windows.ts'
import { FileThumb, IconTile, Quiet } from './shared.tsx'

/*
 * Things only the user can unblock: open approval / clarify / sudo / secret requests (answered in
 * the RequestHost on the Hermes page) and missions whose result is waiting to be looked at.
 */

const REQUEST_COPY: Record<PendingRequest['kind'], { title: string; icon: React.ReactNode }> = {
  approval: { title: 'Approval needed', icon: <IconShieldCheck /> },
  clarify: { title: 'Hermes has a question', icon: <IconMessageQuestion /> },
  sudo: { title: 'Password needed', icon: <IconKey /> },
  secret: { title: 'Password needed', icon: <IconKey /> }
}

function describe(entry: PendingRequest): string {
  const params = entry.request.params as Record<string, unknown>
  const text = [params.description, params.command, params.question, params.prompt, params.tool_name].find((v): v is string => typeof v === 'string' && v.trim().length > 0)

  return text ?? 'Hermes is waiting for you.'
}

export function Attention() {
  const pending = useStore($pendingRequests)
  const reviews = useStore($reviewMissions)
  const empty = pending.length === 0 && reviews.length === 0

  return (
    <Section title="Needs your attention">
      {empty ? (
        <Quiet>Nothing waiting on you.</Quiet>
      ) : (
        <div className="stagger flex flex-col gap-2.5">
          {pending.map(entry => {
            const copy = REQUEST_COPY[entry.kind]

            return (
              <GlassCard key={entry.request.id} className="flex flex-col gap-2.5 p-3">
                <div className="flex items-start gap-2.5">
                  <IconTile size={34}>{copy.icon}</IconTile>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium text-fg">{copy.title}</div>
                    <div className="truncate text-[12px] text-fg-3" title={describe(entry)}>
                      {describe(entry)}
                    </div>
                  </div>
                </div>
                <GlassButton size="sm" variant="primary" className="self-start" onClick={() => showPage('hermes')}>
                  Review
                  <IconArrowRight />
                </GlassButton>
              </GlassCard>
            )
          })}
          {reviews.map(mission => {
            const artifact = mission.artifacts[0]

            return (
              <GlassCard key={mission.id} className="flex flex-col gap-2.5 p-3">
                <div className="flex items-start gap-2.5">
                  <IconTile size={34}>
                    <IconEye />
                  </IconTile>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-fg" title={mission.title}>
                      {mission.title} is ready
                    </div>
                    <div className="text-[12px] text-fg-3">Preview the update before it goes live.</div>
                  </div>
                  {artifact?.kind === 'file' && <FileThumb path={artifact.path} size={128} className="size-11 shrink-0" />}
                </div>
                <GlassButton
                  size="sm"
                  variant="primary"
                  className="self-start"
                  onClick={() => {
                    showPage('hermes')
                    void openStoredSession(mission.id)
                    markReviewed(mission.id)
                  }}
                >
                  Review changes
                  <IconArrowRight />
                </GlassButton>
              </GlassCard>
            )
          })}
        </div>
      )}
    </Section>
  )
}
