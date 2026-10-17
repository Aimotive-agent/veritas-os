import { IconBrain } from '@tabler/icons-react'
import { useState } from 'react'
import { GlassButton } from '../../components/ui/glass.tsx'
import { Spinner } from '../../components/ui/primitives.tsx'
import { notify } from '../../store/notifications.ts'
import { useWithHermes } from '../../store/catalog.ts'
import { MenuDropdown, errorText } from '../settings/sections/shared.tsx'

/** Point Hermes at one of the local server's models. */
export function UseWithHermes({ kind, label }: { kind: 'ollama' | 'lmstudio'; label: string }) {
  const [models, setModels] = useState<string[] | null>(null)
  const [loading, setLoading] = useState(false)

  const load = async () => {
    setLoading(true)

    try {
      setModels(await window.heraldOS.catalog.localModels(kind))
    } catch (error) {
      notify({ title: `${label} is not ready`, body: errorText(error), level: 'warn' })
    } finally {
      setLoading(false)
    }
  }

  const choose = async (model: string) => {
    try {
      await useWithHermes(kind, model)
      notify({ title: `Hermes uses ${model}`, body: `Through ${label} on this computer; switch back in Settings > Hermes & agents.`, level: 'success' })
    } catch (error) {
      notify({ title: 'Could not switch Hermes', body: errorText(error), level: 'error' })
    }
  }

  if (!models) {
    return (
      <GlassButton size="sm" onClick={() => void load()} disabled={loading} aria-label={`Use ${label} with Hermes`}>
        {loading ? <Spinner /> : <IconBrain size={14} />} Use with Hermes
      </GlassButton>
    )
  }

  return <MenuDropdown ariaLabel={`Model on ${label}`} label="Choose a model" items={models.map(model => ({ id: model, label: model }))} onSelect={model => void choose(model)} />
}
