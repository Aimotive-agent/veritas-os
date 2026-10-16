import type { BrandingPatch } from '../../shared/branding.ts'
import { $branding } from '../store/branding.ts'
import { $env } from '../store/backend.ts'
import { fail, ok, type OsCommand } from '../store/os-commands.ts'

/* Branding: About's logo and name, and the lock-screen picture on Veritas OS Linux. */

const describe = () => {
  const view = $branding.get()

  return { name: view.name, logo: Boolean(view.logo), lock: view.lock }
}

export const brandingCommands: readonly OsCommand[] = [
  {
    id: 'branding.show',
    title: 'Branding',
    description: 'The logo and name About shows, and the lock-screen picture (Veritas OS Linux).',
    tier: 'read',
    args: [],
    run: () => {
      const data = describe()

      return ok(
        [data.name ? `Name: ${data.name}` : 'No name', data.logo ? 'a custom logo' : 'the Veritas logo', data.lock ? `lock screen: ${data.lock}` : 'the themed lock screen'].join(', '),
        { data, highlight: { kind: 'setting', id: 'about' } }
      )
    }
  },
  {
    id: 'branding.set',
    title: 'Set the branding',
    description: 'Set the logo and name About shows, or the lock-screen picture (Veritas OS Linux). Images are copied, so the originals can move.',
    tier: 'mutate',
    args: [
      { name: 'logo', type: 'string', description: 'Path to a PNG, JPEG, WebP or SVG logo' },
      { name: 'lock', type: 'string', description: 'Path to a PNG or JPEG for the lock screen' },
      { name: 'name', type: 'string', description: 'A name to show under the logo, such as a company' }
    ],
    run: async ({ logo, lock, name }) => {
      const patch: BrandingPatch = {
        ...(logo !== undefined ? { logo: String(logo) } : {}),
        ...(lock !== undefined ? { lock: String(lock) } : {}),
        ...(name !== undefined ? { name: String(name) } : {})
      }

      if (Object.keys(patch).length === 0) {
        return fail('Give a logo, a lock-screen picture or a name.')
      }

      $branding.set(await window.heraldOS.branding.set(patch))
      const note = patch.lock && $env.get()?.platform !== 'linux' ? ' (the lock-screen picture is used on Veritas OS Linux)' : ''

      return ok(`Branding updated${note}`, { data: describe(), highlight: { kind: 'setting', id: 'about' } })
    }
  },
  {
    id: 'branding.reset',
    title: 'Reset the branding',
    description: 'Go back to the Veritas logo, no name, and the themed lock screen (or reset just one of them).',
    tier: 'mutate',
    args: [{ name: 'what', type: 'string', description: 'all, logo, lock or name', enum: ['all', 'logo', 'lock', 'name'] }],
    run: async ({ what }) => {
      const part = String(what ?? 'all')
      const patch: BrandingPatch = part === 'all' ? { logo: null, lock: null, name: null } : { [part]: null }
      $branding.set(await window.heraldOS.branding.set(patch))

      return ok(part === 'all' ? 'Branding reset' : `Reset the ${part === 'lock' ? 'lock-screen picture' : part}`, { data: describe(), highlight: { kind: 'setting', id: 'about' } })
    }
  }
]
