import { useStore } from '@nanostores/react'
import { type ComponentType, Suspense, lazy } from 'react'
import { SurfaceErrorBoundary } from '../components/error-boundary.tsx'
import { AgentPage } from '../features/agents/AgentPage.tsx'
import { agentIdFromPage } from '../store/agent-pages.ts'
import { $page } from '../store/windows.ts'
import type { PageId } from './apps.ts'
import { Sidebar } from './Sidebar.tsx'

// Pages load on first visit and stay mounted afterwards (keep-alive: chat, files, terminals).
const PAGE_VIEW: Record<PageId, ComponentType> = {
  overview: lazy(() => import('../features/overview/OverviewPage.tsx').then(m => ({ default: m.OverviewPage }))),
  hermes: lazy(() => import('../features/hermes/HermesPage.tsx').then(m => ({ default: m.HermesPage }))),
  agents: lazy(() => import('../features/agents/AgentsPage.tsx').then(m => ({ default: m.AgentsPage }))),
  browser: lazy(() => import('../features/browser/BrowserPage.tsx').then(m => ({ default: m.BrowserPage }))),
  missions: lazy(() => import('../features/missions/MissionsPage.tsx').then(m => ({ default: m.MissionsPage }))),
  memory: lazy(() => import('../features/memory/MemoryPage.tsx').then(m => ({ default: m.MemoryPage }))),
  files: lazy(() => import('../features/files/FilesPage.tsx').then(m => ({ default: m.FilesPage }))),
  automations: lazy(() => import('../features/automations/AutomationsPage.tsx').then(m => ({ default: m.AutomationsPage }))),
  connections: lazy(() => import('../features/connections/ConnectionsPage.tsx').then(m => ({ default: m.ConnectionsPage }))),
  settings: lazy(() => import('../features/settings/SettingsPage.tsx').then(m => ({ default: m.SettingsPage })))
}

const PAGE_LABEL: Record<PageId, string> = {
  overview: 'Overview',
  hermes: 'Hermes',
  agents: 'Agents',
  browser: 'Browser',
  missions: 'Missions',
  memory: 'Memory',
  files: 'Files',
  automations: 'Automations',
  connections: 'Connections',
  settings: 'Settings'
}

const visited = new Set<PageId>(['overview'])

/** Sidebar + the current page. Visited pages stay mounted; only the active one is visible. */
export function MainWindow() {
  const page = useStore($page)
  visited.add(page)

  return (
    <div className="flex h-full">
      <Sidebar />
      <div className="relative min-w-0 flex-1 py-3 pr-3">
        <div className="glass-card relative h-full overflow-hidden rounded-xl" style={{ background: 'var(--color-page, rgba(5, 18, 66, 0.42))' }}>
          {[...visited].map(id => {
            const agentId = agentIdFromPage(id)
            const View = PAGE_VIEW[id as keyof typeof PAGE_VIEW]
            const active = id === page
            const label = agentId ? agentId : (PAGE_LABEL[id as keyof typeof PAGE_LABEL] ?? id)

            return (
              <div key={id} className={active ? 'page-enter absolute inset-0' : 'absolute inset-0'} style={active ? undefined : { visibility: 'hidden', pointerEvents: 'none' }} aria-hidden={!active}>
                <SurfaceErrorBoundary label={label}>
                  <Suspense fallback={<PageSkeleton />}>
                    {agentId ? <AgentPage agentId={agentId} active={active} /> : View ? <View active={active} /> : null}
                  </Suspense>
                </SurfaceErrorBoundary>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function PageSkeleton() {
  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <div className="shimmer h-10 w-64 rounded-lg" />
      <div className="shimmer h-9 w-full rounded-lg" />
      <div className="grid flex-1 grid-cols-3 gap-3">
        <div className="shimmer rounded-xl" />
        <div className="shimmer rounded-xl" />
        <div className="shimmer rounded-xl" />
      </div>
    </div>
  )
}
