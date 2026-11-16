/**
 * The capture data model.
 *
 * Design note: the author drives capture with hotkeys, so the order in which
 * events arrive IS the order of the finished guide. There is no timestamp
 * alignment anywhere. Timestamps are recorded as metadata only (per-step
 * duration, and letting the author re-cut a boundary they forgot to mark).
 */

export const FORMAT_VERSION = 1 as const
/** Stable on-disk identifier, retained for guides created before the product rename. */
export const FORMAT_ID = 'workshop-capture/v1' as const

/** Operating systems we target. Kept here so shared code needs no Node types. */
export type OsId = 'win32' | 'darwin' | 'linux'

export type CalloutKind = 'note' | 'tip' | 'warning'

/** Context grabbed for free at the instant a screenshot lands. */
export interface CaptureContext {
  windowTitle?: string
  processName?: string
  cursor?: { x: number; y: number }
}

export interface StepImage {
  /** Stable identity, so a screenshot can be targeted even as tokens renumber. */
  id: string
  /** Path relative to the project's media/ folder. */
  file: string
  /** Token body: `step-003` renders in guide.md as `{{IMG:step-003}}`. */
  token: string
  width: number
  height: number
  caption?: string
}

export interface StepCode {
  text: string
  lang?: string
}

export interface StepAudio {
  /** Path relative to the project's audio/ folder. Retained so a segment can be re-transcribed. */
  file: string
  durationMs?: number
}

/**
 * A step card. This is the editable model and the source of truth for the app.
 * Capture appends to it; the storyboard edits it; guide.md is generated from it.
 */
export interface Step {
  id: string
  title?: string
  /** Verbatim speech-to-text, or typed by the author. Edited freely in the storyboard. */
  narration: string
  code?: StepCode
  /**
   * Screenshots for this step, in display order.
   *
   * A list rather than a single image because one instruction often needs to
   * show more than one thing - the menu you open and the dialog it produces.
   */
  images?: StepImage[]
  context?: CaptureContext
  callout?: CalloutKind
  /** Starts a new section immediately before this step. */
  sectionBreakBefore?: boolean
  sectionTitle?: string
  /** Author hint to the AI that this is a good place for a knowledge check. */
  quizWorthy?: boolean
  audio?: StepAudio
  /** True while the Whisper sidecar is still working on this step's segment. */
  transcribing?: boolean
  /** Which engine produced the narration, e.g. `whisper:base.en` or `manual`. */
  engine?: string
  /** ISO timestamp of capture. Metadata only - never used for ordering. */
  at: string
}

export interface ProjectMeta {
  title: string
  author: string
  created: string
  updated: string
  /**
   * Product names and UI labels fed to Whisper as an initial prompt.
   * Measurably improves accuracy on jargon like "Entra", "Bicep", "Kusto".
   */
  vocabulary: string[]
}

export interface GuideProject {
  formatVersion: typeof FORMAT_VERSION
  meta: ProjectMeta
  steps: Step[]
}

/** A project loaded into memory, with its location on disk. */
export interface LoadedProject extends GuideProject {
  /** Absolute path to the `.guide` folder. */
  path: string
}

// ---------------------------------------------------------------------------
// Capture session state
// ---------------------------------------------------------------------------

export type RecorderState =
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'capturing'
  | 'captured'
  | 'error'

export interface HudStatus {
  state: RecorderState
  /** Live or most recent transcript text, shown in the HUD. */
  transcript: string
  stepCount: number
  /** Set when state is 'error'. */
  message?: string
  projectTitle?: string
}

// ---------------------------------------------------------------------------
// Derived view: sections
// ---------------------------------------------------------------------------

export interface Section {
  title: string
  steps: Step[]
}

/** Group steps into sections using the `sectionBreakBefore` flags. */
export function toSections(steps: Step[]): Section[] {
  const sections: Section[] = []
  let current: Section | null = null

  for (const step of steps) {
    if (!current || step.sectionBreakBefore) {
      current = { title: step.sectionTitle?.trim() || `Section ${sections.length + 1}`, steps: [] }
      sections.push(current)
    }
    current.steps.push(step)
  }

  return sections
}

/** Stable image token for the Nth image in the guide, e.g. `step-003`. */
export function imageToken(index: number): string {
  return `step-${String(index).padStart(3, '0')}`
}

/** A step's screenshots, tolerating both the absent and legacy single-image shapes. */
export function stepImages(step: Step): StepImage[] {
  return step.images ?? []
}

/** Every screenshot in the guide, in document order, paired with its step. */
export function allImages(steps: Step[]): Array<{ step: Step; image: StepImage }> {
  return steps.flatMap((step) => stepImages(step).map((image) => ({ step, image })))
}

/**
 * Reassign image tokens so they run 001..N in document order.
 * Called after any reorder/delete so guide.md tokens stay predictable.
 */
export function renumberImageTokens(steps: Step[]): Step[] {
  let n = 0
  return steps.map((step) => {
    const images = stepImages(step)
    if (images.length === 0) return step
    return {
      ...step,
      images: images.map((image) => {
        n += 1
        return { ...image, token: imageToken(n) }
      })
    }
  })
}
