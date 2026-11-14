import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { CaptureContext } from '@shared/types'
import type { PlatformAdapter } from './types'

const run = promisify(execFile)

/**
 * macOS adapter. Written from day one so the port is small, but deliberately
 * untested and unsigned for v1 (Windows-first).
 */
export class DarwinAdapter implements PlatformAdapter {
  readonly id: NodeJS.Platform = 'darwin'
  readonly snipToolName = 'Screenshot / Markup'

  screenshotsDir(): string {
    return join(homedir(), 'Desktop')
  }

  /** `-i` interactive selection, `-c` to the clipboard, matching the Windows path. */
  async triggerSnip(): Promise<void> {
    await run('screencapture', ['-i', '-c'])
  }

  async activeWindow(): Promise<CaptureContext> {
    const script = `
      tell application "System Events"
        set frontApp to first application process whose frontmost is true
        set appName to name of frontApp
        try
          set winTitle to name of front window of frontApp
        on error
          set winTitle to ""
        end try
      end tell
      return appName & "\\n" & winTitle
    `
    try {
      const { stdout } = await run('osascript', ['-e', script], { timeout: 2000 })
      const [processName, windowTitle] = stdout.trim().split('\n')
      return {
        processName: processName?.trim() || undefined,
        windowTitle: windowTitle?.trim() || undefined
      }
    } catch {
      // Needs Accessibility permission; never let it break a capture.
      return {}
    }
  }

  /** macOS exposes NSPasteboard.changeCount, but not usefully from a shell; hash instead. */
  async clipboardSequence(): Promise<number | null> {
    return null
  }

  dispose(): void {
    /* nothing to clean up */
  }
}
