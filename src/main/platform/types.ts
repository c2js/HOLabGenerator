import type { CaptureContext } from '@shared/types'

/**
 * The seam between us and the operating system.
 *
 * We deliberately implement almost nothing here: screenshots and annotation are
 * done by the OS's own tools (Snipping Tool / Markup), so this interface only
 * needs to know how to *summon* them and where their output lands.
 */
export interface PlatformAdapter {
  readonly id: NodeJS.Platform

  /** Folder the OS screenshot tool auto-saves into. Watched as a capture path. */
  screenshotsDir(): string

  /**
   * Summon the native region-select + annotation UI.
   * Windows: the `ms-screenclip:` protocol (identical to pressing Win+Shift+S).
   * macOS: `screencapture -i`.
   */
  triggerSnip(): Promise<void>

  /** Foreground window title and owning process, for auto-drafting step context. */
  activeWindow(): Promise<CaptureContext>

  /** Human-readable name of the snip tool, for onboarding and error messages. */
  readonly snipToolName: string

  /**
   * A cheap monotonically-increasing clipboard change counter, if the OS offers
   * one. Returning null makes callers fall back to hashing the image.
   */
  clipboardSequence(): Promise<number | null>

  dispose(): void
}
