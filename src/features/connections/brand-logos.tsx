import { IconPlugConnected } from '@tabler/icons-react'
import type React from 'react'
import { cn } from '../../lib/cn.ts'

/*
 * Inline brand marks for well-known connections, matched by substring of the connection's
 * name / id / logo key. Unknown brands fall back to the blue glass icon tile so the grid stays
 * uniform. Brand colours are the vendors' own and are not theme tokens on purpose.
 */

type Logo = (props: { size: number }) => React.ReactElement

const GoogleDrive: Logo = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 87.3 78" aria-hidden="true">
    <path fill="#0066da" d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" />
    <path fill="#00ac47" d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0-1.2 4.5h27.5z" />
    <path fill="#ea4335" d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z" />
    <path fill="#00832d" d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z" />
    <path fill="#2684fc" d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" />
    <path fill="#ffba00" d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z" />
  </svg>
)

const GoogleCalendar: Logo = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 200 200" aria-hidden="true">
    <path fill="#fff" d="M152.6 47.4H47.4v105.2h105.2z" />
    <path fill="#ea4335" d="M152.6 200l47.4-47.4h-47.4z" />
    <path fill="#fbbc04" d="M200 47.4h-47.4v105.2H200z" />
    <path fill="#34a853" d="M152.6 152.6H47.4V200h105.2z" />
    <path fill="#188038" d="M0 152.6v31.6C0 192.9 7.1 200 15.8 200h31.6v-47.4z" />
    <path fill="#1967d2" d="M200 47.4V15.8C200 7.1 192.9 0 184.2 0h-31.6v47.4z" />
    <path fill="#4285f4" d="M152.6 0H15.8C7.1 0 0 7.1 0 15.8v136.8h47.4V47.4h105.2z" />
    <path fill="#4285f4" d="M69 129c-3.9-2.7-6.7-6.5-8.2-11.6l9.2-3.8c.8 3.2 2.3 5.6 4.4 7.4 2.1 1.7 4.6 2.6 7.6 2.6 3 0 5.6-.9 7.8-2.7 2.2-1.8 3.3-4.1 3.3-6.9 0-2.9-1.2-5.2-3.5-7-2.3-1.8-5.2-2.7-8.7-2.7h-5.3v-9.1h4.8c3 0 5.5-.8 7.6-2.4 2-1.6 3.1-3.8 3.1-6.7 0-2.5-.9-4.5-2.8-6-1.9-1.5-4.2-2.3-7-2.3-2.8 0-5 .7-6.6 2.2-1.6 1.5-2.8 3.3-3.5 5.4l-9.1-3.8c1.2-3.4 3.4-6.4 6.7-9 3.3-2.6 7.4-3.9 12.5-3.9 3.7 0 7.1.7 10.1 2.2 3 1.4 5.3 3.4 7 6 1.7 2.5 2.5 5.4 2.5 8.6 0 3.2-.8 6-2.3 8.2-1.6 2.2-3.5 3.9-5.8 5.1v.5c3 1.3 5.5 3.2 7.4 5.7 1.9 2.6 2.9 5.6 2.9 9.2 0 3.6-.9 6.8-2.7 9.6-1.8 2.8-4.3 5-7.5 6.6-3.2 1.6-6.8 2.4-10.8 2.4-4.6 0-8.9-1.3-12.8-4z" />
    <path fill="#4285f4" d="M121 79.3l-10 7.3-5-7.6 18.1-13.1h6.9v61.6H121z" />
  </svg>
)

const GitHub: Logo = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="12" fill="#24292f" />
    <path fill="#fff" d="M12 4.5a7.5 7.5 0 0 0-2.37 14.62c.37.07.51-.16.51-.36v-1.37c-2.09.45-2.53-.9-2.53-.9-.34-.87-.83-1.1-.83-1.1-.68-.46.05-.45.05-.45.75.05 1.15.77 1.15.77.67 1.15 1.76.82 2.19.63.07-.49.26-.82.48-1.01-1.67-.19-3.42-.83-3.42-3.7 0-.82.29-1.49.77-2.01-.08-.19-.33-.95.07-1.98 0 0 .63-.2 2.06.77a7.2 7.2 0 0 1 3.75 0c1.43-.97 2.06-.77 2.06-.77.4 1.03.15 1.79.07 1.98.48.52.77 1.19.77 2.01 0 2.88-1.75 3.51-3.42 3.7.27.23.51.69.51 1.39v2.05c0 .2.14.44.52.36A7.5 7.5 0 0 0 12 4.5z" />
  </svg>
)

const Slack: Logo = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <path fill="#e01e5a" d="M6 14.5a2 2 0 1 1-2-2h2zm1 0a2 2 0 1 1 4 0v5a2 2 0 1 1-4 0z" />
    <path fill="#36c5f0" d="M9.5 6a2 2 0 1 1 2-2v2zm0 1a2 2 0 1 1 0 4h-5a2 2 0 1 1 0-4z" />
    <path fill="#2eb67d" d="M18 9.5a2 2 0 1 1 2 2h-2zm-1 0a2 2 0 1 1-4 0v-5a2 2 0 1 1 4 0z" />
    <path fill="#ecb22e" d="M14.5 18a2 2 0 1 1-2 2v-2zm0-1a2 2 0 1 1 0-4h5a2 2 0 1 1 0 4z" />
  </svg>
)

const Notion: Logo = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <path fill="#fff" stroke="#111" strokeWidth="1.2" d="M4.5 4.2 15.6 3.4c1.2-.1 1.6.1 2.3.6l3 2.1c.5.4.7.5.7 1v12.4c0 1-.4 1.5-1.6 1.6l-12.9.8c-.9 0-1.4-.1-1.9-.7L2.7 18c-.5-.7-.7-1.2-.7-1.8V5.8c0-.8.4-1.5 1.5-1.6z" />
    <path fill="#111" d="M7.2 8.4v9.2l1.6-.1v-6.4l5 7 1.9-.1V8l-1.6.1v6.1L9.4 8.4z" />
  </svg>
)

const Discord: Logo = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="12" fill="#5865f2" />
    <path fill="#fff" d="M16.9 7.6a11.6 11.6 0 0 0-2.9-.9l-.4.8a10.8 10.8 0 0 0-3.2 0l-.4-.8a11.6 11.6 0 0 0-2.9.9C5.3 10.3 4.8 13 5 15.6a11.7 11.7 0 0 0 3.6 1.8l.7-1.2c-.4-.1-.8-.3-1.2-.6l.3-.2a8.3 8.3 0 0 0 7.2 0l.3.2c-.4.3-.8.5-1.2.6l.7 1.2a11.6 11.6 0 0 0 3.6-1.8c.3-3-.5-5.7-2.1-8zM9.6 14c-.7 0-1.3-.6-1.3-1.4s.6-1.4 1.3-1.4 1.3.6 1.3 1.4-.6 1.4-1.3 1.4zm4.8 0c-.7 0-1.3-.6-1.3-1.4s.6-1.4 1.3-1.4 1.3.6 1.3 1.4-.6 1.4-1.3 1.4z" />
  </svg>
)

const Telegram: Logo = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="12" fill="#29a9eb" />
    <path fill="#fff" d="M5.4 11.6 16.7 7.2c.5-.2 1 .1.8.9l-1.9 9.1c-.1.6-.5.8-1 .5l-3-2.2-1.4 1.4c-.2.2-.3.3-.6.3l.2-3 5.5-5c.2-.2 0-.3-.3-.1l-6.8 4.3-2.9-.9c-.6-.2-.6-.6.1-.9z" />
  </svg>
)

const Gmail: Logo = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <path fill="#4285f4" d="M3.6 19h2.9v-7.2L2.4 8.7v8.7c0 .9.5 1.6 1.2 1.6z" />
    <path fill="#34a853" d="M17.5 19h2.9c.7 0 1.2-.7 1.2-1.6V8.7l-4.1 3.1z" />
    <path fill="#fbbc04" d="M17.5 6.3v5.5l4.1-3.1V7c0-2-2.2-3.1-3.7-1.9z" />
    <path fill="#ea4335" d="M6.5 11.8V6.3L12 10.4l5.5-4.1v5.5L12 15.9z" />
    <path fill="#c5221f" d="M2.4 7v1.7l4.1 3.1V6.3L6.1 5.1C4.6 3.9 2.4 5 2.4 7z" />
  </svg>
)

const Linear: Logo = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <path fill="#5e6ad2" d="M3.1 13.8a9 9 0 0 0 7.1 7.1zM3 11.3l9.7 9.7a9 9 0 0 0 2.1-.4L3.4 9.2c-.2.7-.4 1.4-.4 2.1zm.9-3.7L16.4 20.1c.6-.3 1.1-.7 1.6-1.1L5 6c-.4.5-.8 1-1.1 1.6zM5.9 5c3.5-3.6 9.3-3.6 12.8 0 3.6 3.5 3.6 9.3 0 12.8z" />
  </svg>
)

const Jira: Logo = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <path fill="#2684ff" d="M21.5 11.5 12.9 2.9 12 2l-6.5 6.5-3 3a.8.8 0 0 0 0 1.1l6 6L12 22l6.5-6.5.1-.1 2.9-2.9a.8.8 0 0 0 0-1zM12 15l-3-3 3-3 3 3z" />
    <path fill="#0052cc" d="M12 9a5 5 0 0 1 0-7.1l-6.5 6.6 3.5 3.5z" />
    <path fill="#0052cc" d="M15 12l-3 3a5 5 0 0 1 0 7.1l6.5-6.6z" />
  </svg>
)

const Spotify: Logo = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="12" fill="#1db954" />
    <path fill="#000" d="M17.2 16.6a.7.7 0 0 1-1 .2c-2.7-1.6-6-2-10-1.1a.7.7 0 1 1-.3-1.3c4.3-1 8.1-.6 11 1.2.4.2.5.7.3 1zm1.3-2.9a.9.9 0 0 1-1.2.3c-3.1-1.9-7.7-2.4-11.3-1.3a.9.9 0 1 1-.5-1.7c4.1-1.2 9.2-.6 12.7 1.5.4.3.6.8.3 1.2zm.1-3a1 1 0 0 1-1.4.4c-3.7-2.2-9.7-2.4-13.2-1.3a1 1 0 1 1-.6-2c4-1.2 10.7-1 14.9 1.5.5.3.7 1 .3 1.4z" />
  </svg>
)

const HomeAssistant: Logo = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <path fill="#18bcf2" d="M12 2.5 2.5 12v9.5h19V12z" />
    <path fill="#fff" d="M11.3 20.5v-5.3l-2.5-2.5a1.6 1.6 0 1 1 1-1l1.5 1.5V8.5a1.6 1.6 0 1 1 1.4 0v6.3l1.5-1.5a1.6 1.6 0 1 1 1 1l-2.5 2.5v3.7z" />
  </svg>
)

const WhatsApp: Logo = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="12" fill="#25d366" />
    <path fill="#fff" d="M12 5.5a6.5 6.5 0 0 0-5.6 9.8L5.5 18.5l3.3-.9A6.5 6.5 0 1 0 12 5.5zm0 11.9c-1 0-2-.3-2.8-.8l-.2-.1-2 .5.5-1.9-.1-.2A5.4 5.4 0 1 1 12 17.4zm3-4c-.2-.1-1-.5-1.1-.5s-.3-.1-.4.1l-.5.6c-.1.1-.2.1-.4 0a4.4 4.4 0 0 1-2.2-1.9c-.2-.3.2-.3.5-.9 0-.1 0-.2 0-.3l-.5-1.2c-.1-.3-.3-.3-.4-.3h-.3a.7.7 0 0 0-.5.2 2 2 0 0 0-.6 1.5c0 .9.6 1.7.7 1.8s1.3 2 3.1 2.7c1.1.5 1.6.5 2.1.4.4 0 1-.4 1.2-.9.1-.4.1-.8.1-.9l-.4-.3z" />
  </svg>
)

const OpenAI: Logo = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="12" fill="#000" />
    <path fill="#fff" d="M16.9 10.9a3.5 3.5 0 0 0-.3-2.9 3.6 3.6 0 0 0-3.9-1.7 3.6 3.6 0 0 0-6.1 1.3 3.5 3.5 0 0 0-2.4 1.7 3.6 3.6 0 0 0 .4 4.2 3.5 3.5 0 0 0 .3 2.9 3.6 3.6 0 0 0 3.9 1.7 3.6 3.6 0 0 0 6.1-1.3 3.5 3.5 0 0 0 2.4-1.7 3.6 3.6 0 0 0-.4-4.2zm-5.4 6.2c-.6 0-1.2-.2-1.7-.6l.1-.1 2.8-1.6a.5.5 0 0 0 .2-.4v-4l1.2.7v3.3a2.7 2.7 0 0 1-2.6 2.7zm-5.7-2.4a2.7 2.7 0 0 1-.3-1.8l.1.1 2.8 1.6a.5.5 0 0 0 .5 0l3.4-2v1.4l-2.9 1.7a2.7 2.7 0 0 1-3.6-1zM5 8.6a2.7 2.7 0 0 1 1.4-1.2v3.4a.5.5 0 0 0 .2.4l3.4 2-1.2.7-2.8-1.6A2.7 2.7 0 0 1 5 8.6zm9.8 2.3-3.4-2 1.2-.7 2.8 1.6a2.7 2.7 0 0 1-.4 4.8v-3.3a.5.5 0 0 0-.2-.4zm1.2-1.8-.1-.1-2.8-1.6a.5.5 0 0 0-.5 0l-3.4 2V8l2.9-1.7a2.7 2.7 0 0 1 3.9 2.8zm-7.4 2.4-1.2-.7V7.5a2.7 2.7 0 0 1 4.3-2.1l-.1.1-2.8 1.6a.5.5 0 0 0-.2.4zm.7-1.4 1.5-.9 1.5.9v1.7l-1.5.9-1.5-.9z" />
  </svg>
)

const Anthropic: Logo = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <rect width="24" height="24" rx="6" fill="#d97757" />
    <path fill="#fff" d="M13.6 6h2.6l4.6 12h-2.6zM8.1 6h2.7l4.6 12h-2.6l-.9-2.5H7.1L6.2 18H3.5zm-.2 7.4h3.4L9.6 8.9z" />
  </svg>
)

const Nous: Logo = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <rect width="24" height="24" rx="6" fill="#0f0f13" />
    <path fill="none" stroke="#f4f0e6" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" d="M6.5 17.5v-11l11 11v-11" />
  </svg>
)

const BRANDS: [RegExp, Logo][] = [
  [/google[ _-]?drive|gdrive|\bdrive\b/i, GoogleDrive],
  [/google[ _-]?calendar|gcal|calendar/i, GoogleCalendar],
  [/github/i, GitHub],
  [/slack/i, Slack],
  [/notion/i, Notion],
  [/discord/i, Discord],
  [/telegram/i, Telegram],
  [/gmail|google[ _-]?mail/i, Gmail],
  [/linear/i, Linear],
  [/jira|atlassian/i, Jira],
  [/spotify/i, Spotify],
  [/home[ _-]?assistant|\bhass\b|homeassistant/i, HomeAssistant],
  [/whatsapp/i, WhatsApp],
  [/openai|codex|chatgpt/i, OpenAI],
  [/anthropic|claude/i, Anthropic],
  [/\bnous\b/i, Nous]
]

export function findBrand(keys: readonly (string | undefined)[]): Logo | null {
  const haystack = keys.filter(Boolean).join(' ')

  for (const [pattern, logo] of BRANDS) {
    if (pattern.test(haystack)) {
      return logo
    }
  }

  return null
}

/** Brand mark on a white tile when known, otherwise the blue glass icon tile. */
export function BrandLogo({ keys, size = 44, className }: { keys: readonly (string | undefined)[]; size?: number; className?: string }) {
  const Logo = findBrand(keys)
  const radius = Math.round(size * 0.24)

  if (!Logo) {
    return (
      <span className={cn('icon-tile shrink-0', className)} style={{ width: size, height: size, borderRadius: radius }} aria-hidden="true">
        <IconPlugConnected size={Math.round(size * 0.5)} stroke={1.7} />
      </span>
    )
  }

  return (
    <span className={cn('inline-flex shrink-0 items-center justify-center bg-paper shadow-[0_2px_10px_rgba(0,10,60,.45)]', className)} style={{ width: size, height: size, borderRadius: radius }} aria-hidden="true">
      <Logo size={Math.round(size * 0.62)} />
    </span>
  )
}
