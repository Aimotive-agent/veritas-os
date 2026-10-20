import type { HeraldOSApi } from '../../preload/index'

declare global {
  interface Window {
    heraldOS: HeraldOSApi
  }
}

export {}
