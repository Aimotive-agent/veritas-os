import { notify } from '../../store/notifications.ts'

/** Open a project folder or file in the first installed code editor; a notice says why when that fails. */
export function openInEditor(target: string): void {
  window.heraldOS.fs.openIn('editor', target).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)

    // ipcRenderer.invoke prefixes "Error invoking remote method '<channel>': Error: ".
    notify({ title: 'Could not open a code editor', body: message.replace(/^Error invoking remote method '[^']*': (?:\w+: )?/, ''), level: 'error' })
  })
}
