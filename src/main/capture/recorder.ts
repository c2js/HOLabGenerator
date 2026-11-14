import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import {
  imageToken,
  renumberImageTokens,
  stepImages,
  type CaptureContext,
  type HudStatus,
  type RecorderState,
  type Step,
  type StepCode,
  type StepImage
} from '@shared/types'
import { audioPath, mediaPath, type ProjectStore } from '../project/store'

/**
 * Assembles the hotkey event stream into step cards.
 *
 * The rules are intentionally boring, because the author must be able to
 * predict them while their attention is on the task they are demonstrating:
 *
 *   - narration appends to the *open* step
 *   - a screenshot attaches to the open step and *closes* it
 *   - the next narration after a closed step starts a new step
 *   - a clipboard capture attaches a code block to the open step
 *   - a section break marks whichever step comes next
 *
 * "Open step" simply means: the last step, if it does not have an image yet.
 */
export class Recorder extends EventEmitter {
  private _state: RecorderState = 'idle'
  private _transcript = ''
  private _message: string | undefined
  private pendingSectionBreak = false
  private pendingSectionTitle: string | undefined
  /**
   * The step currently accepting content. Tracked explicitly rather than
   * inferred, so that a section break (and opening a project from a previous
   * session) can close a step that has no screenshot yet.
   */
  private openStepId: string | null = null

  constructor(private readonly store: ProjectStore) {
    super()
  }

  /** Called when a project is opened, created or closed: never continue a previous session's step. */
  resetSession(): void {
    this.openStepId = null
    this.pendingSectionBreak = false
    this.pendingSectionTitle = undefined
    this._transcript = ''
    this._state = 'idle'
    this._message = undefined
    this.notifyStatus()
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  get state(): RecorderState {
    return this._state
  }

  get status(): HudStatus {
    return {
      state: this._state,
      transcript: this._transcript,
      stepCount: this.store.current?.steps.length ?? 0,
      message: this._message,
      projectTitle: this.store.current?.meta.title
    }
  }

  setState(state: RecorderState, opts: { transcript?: string; message?: string } = {}): void {
    this._state = state
    if (opts.transcript !== undefined) this._transcript = opts.transcript
    this._message = state === 'error' ? opts.message : undefined
    this.emit('status', this.status)
  }

  setTranscript(text: string): void {
    this._transcript = text
    this.emit('status', this.status)
  }

  notifyStatus(): void {
    this.emit('status', this.status)
  }

  // -------------------------------------------------------------------------
  // Step assembly
  // -------------------------------------------------------------------------

  private steps(): Step[] {
    return this.store.current?.steps ?? []
  }

  /** The step currently accepting content, if any. */
  private openStep(): Step | null {
    if (!this.openStepId) return null
    return this.steps().find((s) => s.id === this.openStepId) ?? null
  }

  private static isEmpty(step: Step): boolean {
    return !step.narration.trim() && !step.code && stepImages(step).length === 0
  }

  private newStep(): Step {
    const step: Step = {
      id: randomUUID(),
      narration: '',
      at: new Date().toISOString()
    }
    if (this.pendingSectionBreak) {
      step.sectionBreakBefore = true
      step.sectionTitle = this.pendingSectionTitle
      this.pendingSectionBreak = false
      this.pendingSectionTitle = undefined
    }
    return step
  }

  /** Get the open step, creating one if the previous step is already closed. */
  private ensureOpenStep(): Step {
    const open = this.openStep()
    if (open) return open

    const step = this.newStep()
    this.store.update((p) => ({ ...p, steps: [...p.steps, step] }))
    this.openStepId = step.id
    return step
  }

  private commit(mutate: (steps: Step[]) => Step[]): void {
    this.store.update((p) => ({ ...p, steps: mutate([...p.steps]) }))
    this.notifyStatus()
  }

  // -------------------------------------------------------------------------
  // Capture entry points
  // -------------------------------------------------------------------------

  /**
   * Reserve a step for a dictation segment that is still being transcribed, so
   * the card appears immediately and fills in when Whisper finishes.
   */
  beginNarration(audioFile: string): string {
    const step = this.ensureOpenStep()
    this.commit((steps) =>
      steps.map((s) =>
        s.id === step.id
          ? { ...s, transcribing: true, audio: { file: audioFile } }
          : s
      )
    )
    return step.id
  }

  /** Fill in (or append to) a step's narration once transcription completes. */
  completeNarration(
    stepId: string,
    text: string,
    opts: { engine?: string; durationMs?: number } = {}
  ): void {
    const clean = text.trim()
    this.commit((steps) =>
      steps.map((s) => {
        if (s.id !== stepId) return s
        const narration = s.narration ? `${s.narration} ${clean}`.trim() : clean
        return {
          ...s,
          narration,
          transcribing: false,
          engine: opts.engine ?? s.engine,
          audio: s.audio ? { ...s.audio, durationMs: opts.durationMs ?? s.audio.durationMs } : s.audio
        }
      })
    )
  }

  failNarration(stepId: string): void {
    this.commit((steps) => steps.map((s) => (s.id === stepId ? { ...s, transcribing: false } : s)))
  }

  /** Overwrite a step's narration outright, used when re-transcribing existing audio. */
  replaceNarration(stepId: string, text: string, engine?: string): void {
    const clean = text.trim()
    this.commit((steps) =>
      steps.map((s) =>
        s.id === stepId ? { ...s, narration: clean, transcribing: false, engine } : s
      )
    )
  }

  /**
   * Detach a step's audio and return its filename so the caller can delete it.
   *
   * Once the words are safely in the transcript the WAV is dead weight - a few
   * hundred kilobytes per step that would otherwise sit in the project forever.
   */
  takeAudio(stepId: string): string | null {
    const step = this.steps().find((s) => s.id === stepId)
    const file = step?.audio?.file ?? null
    if (!file) return null

    this.commit((steps) =>
      steps.map((s) => (s.id === stepId ? { ...s, audio: undefined } : s))
    )
    return file
  }

  /** Add narration directly (typed by the author, or from the HUD fallback). */
  addNarration(text: string, engine = 'manual'): void {
    const clean = text.trim()
    if (!clean) return
    const step = this.ensureOpenStep()
    this.commit((steps) =>
      steps.map((s) =>
        s.id === step.id
          ? { ...s, narration: s.narration ? `${s.narration} ${clean}`.trim() : clean, engine }
          : s
      )
    )
  }

  /** Attach a screenshot to the open step, closing it. Returns the new image's id. */
  attachImage(
    image: Omit<StepImage, 'token' | 'id'>,
    context?: CaptureContext
  ): { stepId: string; imageId: string } {
    const step = this.ensureOpenStep()
    const imageId = randomUUID()

    this.commit((steps) =>
      renumberImageTokens(
        steps.map((s) =>
          s.id === step.id
            ? {
                ...s,
                images: [...stepImages(s), { ...image, id: imageId, token: imageToken(0) }],
                context: context ?? s.context
              }
            : s
        )
      )
    )

    this.openStepId = null
    return { stepId: step.id, imageId }
  }

  /** Append a screenshot to an existing step, without touching the capture flow. */
  addImageToStep(
    stepId: string,
    image: Omit<StepImage, 'token' | 'id'>
  ): string | null {
    if (!this.steps().some((s) => s.id === stepId)) return null
    const imageId = randomUUID()

    this.commit((steps) =>
      renumberImageTokens(
        steps.map((s) =>
          s.id === stepId
            ? { ...s, images: [...stepImages(s), { ...image, id: imageId, token: imageToken(0) }] }
            : s
        )
      )
    )

    return imageId
  }

  /**
   * Swap one screenshot for a newer one, returning the old filename so the
   * caller can delete it. Used when the annotated version arrives after the raw
   * selection has already been attached.
   */
  replaceImage(imageId: string, image: Omit<StepImage, 'token' | 'id'>): string | null {
    const existing = this.findImage(imageId)
    if (!existing) return null

    this.commit((steps) =>
      renumberImageTokens(
        steps.map((s) => ({
          ...s,
          images: stepImages(s).map((img) =>
            img.id === imageId ? { ...img, ...image, id: img.id, token: img.token } : img
          )
        }))
      )
    )

    return existing.image.file === image.file ? null : existing.image.file
  }

  /** Remove one screenshot, returning its filename so the caller can delete it. */
  removeImage(imageId: string): string | null {
    const existing = this.findImage(imageId)
    if (!existing) return null

    this.commit((steps) =>
      renumberImageTokens(
        steps.map((s) => ({ ...s, images: stepImages(s).filter((img) => img.id !== imageId) }))
      )
    )

    return existing.image.file
  }

  findImage(imageId: string): { step: Step; image: StepImage } | null {
    for (const step of this.steps()) {
      const image = stepImages(step).find((img) => img.id === imageId)
      if (image) return { step, image }
    }
    return null
  }

  addCode(code: StepCode): void {
    const step = this.ensureOpenStep()
    this.commit((steps) => steps.map((s) => (s.id === step.id ? { ...s, code } : s)))
  }

  /**
   * Mark a section boundary.
   *
   * A break closes whatever step is open, because "that section is done" always
   * means the narration that follows belongs to a new step. Only an entirely
   * empty open step is reused, so pressing the hotkey twice does not strand a
   * blank card.
   */
  sectionBreak(title?: string): void {
    const open = this.openStep()
    if (open && Recorder.isEmpty(open)) {
      this.commit((steps) =>
        steps.map((s) =>
          s.id === open.id ? { ...s, sectionBreakBefore: true, sectionTitle: title } : s
        )
      )
      return
    }

    this.openStepId = null
    this.pendingSectionBreak = true
    this.pendingSectionTitle = title
    this.notifyStatus()
  }

  /**
   * "Scratch that" - drop the most recent step and its media/audio.
   * Deliberately destructive and instant; recovery is just doing the step again.
   */
  async scratch(): Promise<Step | null> {
    const project = this.store.current
    const steps = this.steps()
    const last = steps[steps.length - 1]
    if (!project || !last) return null

    this.commit((all) => renumberImageTokens(all.slice(0, -1)))
    if (this.openStepId === last.id) this.openStepId = null

    const removals: string[] = []
    for (const image of stepImages(last)) removals.push(mediaPath(project, image.file))
    if (last.audio) removals.push(audioPath(project, last.audio.file))
    await Promise.all(
      removals.map((p) => fs.rm(p, { force: true }).catch(() => undefined))
    )

    return last
  }
}
