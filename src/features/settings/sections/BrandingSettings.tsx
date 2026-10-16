import { useStore } from '@nanostores/react'
import { IconId, IconLock, IconPhoto } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { HeraldLogo } from '../../../components/herald-logo.tsx'
import { GlassButton, GlassCard } from '../../../components/ui/glass.tsx'
import { $env } from '../../../store/backend.ts'
import { $branding } from '../../../store/branding.ts'
import { notify } from '../../../store/notifications.ts'
import { runCommand } from '../../../store/os-commands.ts'
import { markSaved, SettingsBlock, SettingsGroup, SettingsRow } from './shared.tsx'

async function run(command: string, args: Record<string, unknown>) {
  const result = await runCommand(command, args, { source: 'ui' })

  if (result.ok) {
    markSaved()
  } else {
    notify({ title: 'Could not change the branding', body: result.error ?? result.summary, level: 'error' })
  }
}

async function choose(kind: 'logo' | 'lock') {
  try {
    const [file] = await window.heraldOS.fs.pickFiles({ directory: false, multiple: false })

    if (file) {
      await run('branding.set', { [kind]: file })
    }
  } catch (error) {
    notify({ title: 'Could not choose the picture', body: error instanceof Error ? error.message : String(error), level: 'error' })
  }
}

/** The top of About: the Veritas logo, or the logo and name the person set. */
export function AboutIdentity() {
  const env = useStore($env)
  const branding = useStore($branding)

  return (
    <SettingsBlock label="Veritas OS" description={branding.name ?? undefined} keywords="about logo branding version">
      <GlassCard className="flex items-center gap-4 p-5">
        {branding.logo ? <img src={branding.logo} alt={branding.name ? `${branding.name} logo` : 'Logo'} className="h-12 max-w-[180px] object-contain" /> : <HeraldLogo height={28} />}
        <div className="min-w-0">
          {branding.name && <div className="truncate text-[15px] font-semibold text-fg">{branding.name}</div>}
          <div className={branding.name ? 'text-[12.5px] text-fg-3' : 'text-[15px] font-semibold text-fg'}>Veritas OS {env?.version ?? ''}</div>
        </div>
      </GlassCard>
    </SettingsBlock>
  )
}

/** Settings > About > Branding: the logo, a name under it, and the lock-screen picture on Linux. */
export function BrandingSettings() {
  const env = useStore($env)
  const branding = useStore($branding)
  const [name, setName] = useState(branding.name ?? '')

  useEffect(() => setName(branding.name ?? ''), [branding.name])

  const saveName = () => {
    if (name.trim() !== (branding.name ?? '')) {
      void run('branding.set', { name: name.trim() })
    }
  }

  return (
    <SettingsGroup title="Branding">
      <SettingsRow icon={<IconPhoto />} label="Logo" description={branding.logo ? 'Yours, shown above.' : 'The Veritas logo. A PNG, JPEG, WebP or SVG of your own replaces it.'} keywords="branding logo company">
        {branding.logo && (
          <GlassButton size="sm" variant="ghost" onClick={() => void run('branding.reset', { what: 'logo' })}>
            Use the Veritas logo
          </GlassButton>
        )}
        <GlassButton size="sm" onClick={() => void choose('logo')}>
          Choose…
        </GlassButton>
      </SettingsRow>
      <SettingsRow icon={<IconId />} label="Name" description="Shown under the logo, such as your company." keywords="branding name company organisation">
        <input
          value={name}
          onChange={event => setName(event.target.value)}
          onBlur={saveName}
          onKeyDown={event => event.key === 'Enter' && event.currentTarget.blur()}
          maxLength={40}
          placeholder="None"
          aria-label="Branding name"
          className="glass-input h-8 w-[200px] rounded-lg px-2.5 text-[12.5px] outline-none"
        />
      </SettingsRow>
      {env?.platform === 'linux' && (
        <SettingsRow
          icon={<IconLock />}
          label="Lock screen picture"
          description={branding.lock ? <span className="selectable">{branding.lock.split('/').pop()}</span> : 'The theme colours. A PNG or JPEG of your own goes behind the password ring.'}
          keywords="branding lock screen wallpaper swaylock"
        >
          {branding.lock && (
            <GlassButton size="sm" variant="ghost" onClick={() => void run('branding.reset', { what: 'lock' })}>
              Use the theme
            </GlassButton>
          )}
          <GlassButton size="sm" onClick={() => void choose('lock')}>
            Choose…
          </GlassButton>
        </SettingsRow>
      )}
    </SettingsGroup>
  )
}
