import { useStore } from '@nanostores/react'
import { IconCpu, IconDownload, IconTrash } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { type ModelId, modelBytes, modelInfo, MODELS, sizeLabel } from '../../../../shared/canvas/models.ts'
import { GlassButton } from '../../../components/ui/glass.tsx'
import { Modal } from '../dialogs.tsx'
import { $dialog } from '../menus.ts'
import { $downloads, $modelAsk, $models, cancelDownload, download, refreshModels, removeModel } from './models.ts'

function Progress({ id }: { id: ModelId }) {
  const progress = useStore($downloads)[id]
  const total = progress?.total || modelBytes(modelInfo(id))
  const received = progress?.received ?? 0

  return (
    <div className="flex flex-col gap-1.5">
      <div className="h-1.5 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={received}>
        <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${Math.min(100, (received / total) * 100)}%` }} />
      </div>
      <div className="text-[11.5px] text-fg-3 tabular-nums">
        {sizeLabel(received)} of {sizeLabel(total)}
      </div>
    </div>
  )
}

const ModelFacts = ({ id }: { id: ModelId }) => {
  const model = modelInfo(id)

  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
      <dt className="text-fg-3">Size</dt>
      <dd className="text-fg-2 tabular-nums">{sizeLabel(modelBytes(model))}</dd>
      <dt className="text-fg-3">Licence</dt>
      <dd className="text-fg-2">{model.licence}</dd>
      <dt className="text-fg-3">From</dt>
      <dd className="truncate text-fg-2" title={model.files[0].url}>
        {model.source.replace(/^https:\/\//, '')}
      </dd>
    </dl>
  )
}

/** The question before a model's first download, then its progress (with Cancel), until it is ready. */
export function ModelPrompt() {
  const ask = useStore($modelAsk)
  const [phase, setPhase] = useState<'ask' | 'downloading' | 'failed'>('ask')
  const progress = useStore($downloads)[ask?.id ?? 'isnet']

  useEffect(() => setPhase('ask'), [ask?.id])

  if (!ask) {
    return null
  }

  const model = modelInfo(ask.id)
  const finish = (ready: boolean) => {
    $modelAsk.set(null)
    ask.answer(ready)
  }
  const start = () => {
    setPhase('downloading')
    void download(ask.id).then((ready) => (ready ? finish(true) : setPhase('failed')))
  }
  const failure = progress?.outcome && typeof progress.outcome === 'object' ? progress.outcome.error : progress?.outcome === 'cancelled' ? 'The download was cancelled.' : 'The download did not finish.'

  return (
    <Modal title={phase === 'ask' ? `Download ${model.name}?` : phase === 'downloading' ? `Downloading ${model.name}` : 'The download stopped'} onClose={() => (phase === 'downloading' ? void cancelDownload(ask.id) : finish(false))}>
      <div className="flex flex-col gap-4">
        <p className="text-[12.5px] text-fg-2">
          {ask.why} needs a model on this computer: {model.name}, which {model.purpose}. It runs here, so the picture never leaves your computer.
        </p>
        <ModelFacts id={ask.id} />
        {phase === 'downloading' && <Progress id={ask.id} />}
        {phase === 'failed' && <p className="text-[12px] text-danger">{failure}</p>}
        <div className="flex justify-end gap-2">
          {phase === 'downloading' ? (
            <GlassButton variant="ghost" onClick={() => void cancelDownload(ask.id)}>
              Cancel download
            </GlassButton>
          ) : (
            <>
              <GlassButton variant="ghost" onClick={() => finish(false)}>
                {phase === 'failed' ? 'Close' : 'Not now'}
              </GlassButton>
              <GlassButton variant="primary" onClick={start}>
                <IconDownload size={14} /> {phase === 'failed' ? 'Try again' : `Download ${sizeLabel(modelBytes(model))}`}
              </GlassButton>
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}

/** Edit > AI Models: what is downloaded, how big it is, and a way to remove it (or fetch it). */
export function ModelsDialog() {
  const models = useStore($models)
  const downloads = useStore($downloads)
  const [busy, setBusy] = useState<ModelId | null>(null)
  const close = () => $dialog.set(null)

  useEffect(() => void refreshModels(), [])

  return (
    <Modal title="AI models" onClose={close} className="max-w-xl">
      <p className="mb-3 text-[12px] text-fg-3">These run on this computer. They download when a tool first needs one, after you allow it, and are checked against their published checksums before they run.</p>
      <div className="flex flex-col divide-y divide-line rounded-xl ring-1 ring-line">
        {MODELS.map((model) => {
          const status = models[model.id]
          const downloading = status?.state === 'downloading' || (downloads[model.id] && !downloads[model.id]?.outcome)
          // A stopped download keeps the files it finished (checked again before they run).
          const partial = status?.state === 'missing' && status.bytes > 0
          const remove = (
            <GlassButton
              size="sm"
              variant="ghost"
              disabled={busy === model.id}
              aria-label={`Remove ${model.name}`}
              onClick={() => {
                setBusy(model.id)
                void removeModel(model.id).finally(() => setBusy(null))
              }}
            >
              <IconTrash size={14} /> Remove
            </GlassButton>
          )

          return (
            <div key={model.id} className="flex items-center gap-3 px-3 py-2.5">
              <IconCpu size={18} className="shrink-0 text-fg-3" />
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] text-fg">{model.name}</div>
                <div className="truncate text-[11.5px] text-fg-3 first-letter:uppercase" title={model.purpose}>
                  {model.purpose} · {model.licence}
                </div>
                {downloading && (
                  <div className="mt-1.5">
                    <Progress id={model.id} />
                  </div>
                )}
              </div>
              <div className="shrink-0 text-right text-[11.5px] text-fg-3 tabular-nums">
                {status?.state === 'ready' ? sizeLabel(status.bytes) : downloading ? '' : partial ? `${sizeLabel(status.bytes)} of ${sizeLabel(modelBytes(model))}` : `Not downloaded (${sizeLabel(modelBytes(model))})`}
              </div>
              {status?.state === 'ready' ? (
                remove
              ) : downloading ? (
                <GlassButton size="sm" variant="ghost" onClick={() => void cancelDownload(model.id)}>
                  Cancel
                </GlassButton>
              ) : (
                <>
                  <GlassButton size="sm" variant="ghost" aria-label={`Download ${model.name}`} onClick={() => void download(model.id)}>
                    <IconDownload size={14} /> {partial ? 'Resume' : 'Download'}
                  </GlassButton>
                  {partial && remove}
                </>
              )}
            </div>
          )
        })}
      </div>
      <div className="mt-4 flex justify-end">
        <GlassButton variant="primary" onClick={close}>
          Done
        </GlassButton>
      </div>
    </Modal>
  )
}
