import { useStore } from '@nanostores/react'
import { IconPlus, IconTarget } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { EmptyGlass, GlassButton, GlassCard, LinkAction, MoreButton, PageHeader, Section, Tabs, type TabDef } from '../../components/ui/glass.tsx'
import { $activeMissions, $activity, $completedMissions, $missionFocus, $reviewMissions } from '../../store/missions.ts'
import { ActivityTimeline } from './ActivityTimeline.tsx'
import { MissionCard } from './MissionCard.tsx'
import { MissionComposer } from './MissionComposer.tsx'
import { MissionDetail } from './MissionDetail.tsx'

type TabId = 'active' | 'review' | 'completed'

const ACTIVITY_SHORT = 6
const ACTIVITY_LONG = 20

const EMPTY_COPY: Record<TabId, { title: string; description: string }> = {
  active: { title: 'No active missions', description: 'Start a mission and Hermes will plan the steps and work through them.' },
  review: { title: 'Nothing needs review', description: 'Finished missions wait here until you have looked at them.' },
  completed: { title: 'No completed missions yet', description: 'Missions you have reviewed end up here.' }
}

export function MissionsPage() {
  const active = useStore($activeMissions)
  const review = useStore($reviewMissions)
  const completed = useStore($completedMissions)
  const activity = useStore($activity)
  const [tab, setTab] = useState<TabId>('active')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showAllActivity, setShowAllActivity] = useState(false)
  const [composing, setComposing] = useState(false)

  // A command (voice, agent) asked for a tab, a mission or the composer: follow it.
  const focus = useStore($missionFocus)

  useEffect(() => {
    if (!focus) {
      return
    }

    if (focus.tab) {
      setTab(focus.tab === 'queued' ? 'active' : focus.tab)
    }

    if (focus.missionId) {
      setSelectedId(focus.missionId)
    }

    if (focus.compose) {
      setComposing(true)
    }
  }, [focus])

  const tabs: readonly TabDef<TabId>[] = [
    { id: 'active', label: 'Active', count: active.length },
    { id: 'review', label: 'Needs review', count: review.length },
    { id: 'completed', label: 'Completed', count: completed.length }
  ]
  const list = tab === 'active' ? active : tab === 'review' ? review : completed
  // Auto-select the first mission of the current tab when nothing (or something gone) is selected.
  const selected = list.find(m => m.id === selectedId) ?? list[0] ?? null
  const recent = activity.slice(0, showAllActivity ? ACTIVITY_LONG : ACTIVITY_SHORT)

  const changeTab = (next: TabId) => {
    setTab(next)
    setSelectedId(null)
  }

  return (
    <div className="page-enter flex h-full flex-col">
      <PageHeader
        icon="missions"
        title="Missions"
        subtitle="From intent to finished work."
        actions={
          <>
            <GlassButton onClick={() => setComposing(true)} aria-label="New mission">
              <IconPlus />
              New mission
            </GlassButton>
            <MoreButton />
          </>
        }
      />

      <div className="flex min-h-0 flex-1 gap-4 px-6 pb-6">
        <div className="flex min-w-0 flex-1 flex-col gap-5 overflow-y-auto pr-1">
          <Tabs tabs={tabs} value={tab} onChange={changeTab} className="self-start" />

          {list.length === 0 ? (
            <EmptyGlass
              icon={<IconTarget />}
              title={EMPTY_COPY[tab].title}
              description={EMPTY_COPY[tab].description}
              action={
                tab === 'active' ? (
                  <GlassButton size="sm" variant="primary" onClick={() => setComposing(true)}>
                    <IconPlus />
                    New mission
                  </GlassButton>
                ) : undefined
              }
            />
          ) : (
            <div className="stagger flex flex-col gap-3">
              {list.map(mission => (
                <MissionCard key={mission.id} mission={mission} selected={selected?.id === mission.id} onSelect={() => setSelectedId(mission.id)} />
              ))}
            </div>
          )}

          <Section
            title="Recent activity"
            action={
              activity.length > ACTIVITY_SHORT ? (
                <LinkAction onClick={() => setShowAllActivity(v => !v)}>{showAllActivity ? 'Show less' : 'View all'}</LinkAction>
              ) : undefined
            }
          >
            <ActivityTimeline entries={recent} />
          </Section>
        </div>

        <div className="flex w-[420px] shrink-0 flex-col gap-3">
          {composing && <MissionComposer onClose={() => setComposing(false)} />}
          <GlassCard className="flex min-h-0 flex-1 flex-col overflow-y-auto p-5">
            {selected ? (
              <MissionDetail key={selected.id} mission={selected} />
            ) : (
              <EmptyGlass icon={<IconTarget />} title="Select a mission" description="Pick a mission on the left to see its plan, preview and activity." className="flex-1" />
            )}
          </GlassCard>
        </div>
      </div>
    </div>
  )
}
