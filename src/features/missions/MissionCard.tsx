import { IconChevronRight } from '@tabler/icons-react'
import { GlassCard, Pill, ProgressBar } from '../../components/ui/glass.tsx'
import type { Mission } from '../../store/missions.ts'
import { deriveAgentName, missionIcon, STATUS_LABEL, STATUS_TONE } from './mission-helpers.ts'

export function MissionCard({ mission, selected, onSelect }: { mission: Mission; selected: boolean; onSelect: () => void }) {
  const Icon = missionIcon(mission.title)
  const agent = mission.agents[0] ? deriveAgentName(mission.goal) : 'Hermes'
  const step = mission.currentStep || STATUS_LABEL[mission.status]
  const showProgress = mission.status === 'active' || mission.status === 'queued'

  return (
    <GlassCard as="button" interactive selected={selected} onClick={onSelect} className="w-full p-3.5" data-os-target={`mission:${mission.id}`}>
      <div className="flex items-center gap-3">
        <span className="icon-tile size-11 shrink-0" style={{ borderRadius: 11 }}>
          <Icon size={22} stroke={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-medium text-fg">{mission.title}</div>
          <div className="truncate text-[12px] text-fg-3">
            {agent} · {step}
          </div>
        </div>
        <Pill tone={STATUS_TONE[mission.status]}>{STATUS_LABEL[mission.status]}</Pill>
        <IconChevronRight size={16} className="shrink-0 text-fg-4" />
      </div>
      {showProgress && (
        <div className="mt-3 flex items-center gap-3 pl-14">
          <ProgressBar value={mission.progress} tone="accent" className="flex-1" />
          <span className="w-9 shrink-0 text-right text-[11.5px] text-fg-3 tabular-nums">{mission.progress}%</span>
        </div>
      )}
    </GlassCard>
  )
}
