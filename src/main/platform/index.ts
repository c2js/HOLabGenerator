import type { PlatformAdapter } from './types'
import { Win32Adapter } from './win32'
import { DarwinAdapter } from './darwin'

export type { PlatformAdapter } from './types'

let cached: PlatformAdapter | null = null

export function platform(): PlatformAdapter {
  if (cached) return cached
  cached = process.platform === 'darwin' ? new DarwinAdapter() : new Win32Adapter()
  return cached
}

export function disposePlatform(): void {
  cached?.dispose()
  cached = null
}
