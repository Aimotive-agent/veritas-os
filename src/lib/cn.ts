import { clsx, type ClassValue } from 'clsx'

/** Conditional class names (a `clsx` re-export; the app does not use tailwind-merge). */
export function cn(...inputs: ClassValue[]): string {
  return clsx(...inputs)
}
