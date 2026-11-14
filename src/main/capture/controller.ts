import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { clipboard, screen } from 'electron'
import type { CaptureContext, LoadedProject } from '@shared/types'
import { audioDir, audioPath, mediaDir, mediaPath, type ProjectStore } from '../project/store'
import type { PlatformAdapter } from '../platform'
import type { Recorder } from './recorder'
import { Dictation } from './dictation'
import { SnipIngest, type ClipboardBaseline } from './snip'
import { WhisperEngine } from './whisper'

/**
 * How long after a capture a newer image still counts as "the annotated
 * version". Long enough to open the editor, draw an arrow and hit Copy;
 * short enough that an unrelated screenshot minutes later is not mistaken
 * for one.
 */
const ANNOTATION_GRACE_MS = 60_000

export interface ControllerEvents {
  toast: (kind: 'info' | 'success' | 'warning' | 'error', text: string) => void
}

/**
 * Orchestrates the hotkey actions.
 *
 * The one rule that matters here: a snip always finalises the current dictation
 * segment first. That is what guarantees the narration the author just spoke is
 * ordered *before* the screenshot they are about to take, without any
 * timestamp reconciliation.
 */
export class CaptureController {
  private readonly dictation = new Dictation()
  private readonly snipIngest: SnipIngest
  private inFlightTranscriptions = 0
  /** The screenshot currently eligible to be replaced by an annotated version. */
  private refinementImageId: string | null = null

  constructor(
    private readonly store: ProjectStore,
    private readonly recorder: Recorder,
    private readonly platform: PlatformAdapter,
    private readonly whisper: WhisperEngine,
    private readonly events: ControllerEvents
  ) {
    this.snipIngest = new SnipIngest(platform)

    this.dictation.on('error', (message: string) => {
      this.recorder.setState('error', { message })
      this.events.toast('error', message)
    })

    // Warn, then cut. A four-minute take is already an unwieldy step, and
    // Whisper gets slower the longer the clip.
    this.dictation.on('warning', () => {
      this.recorder.setState('listening', {
        transcript: 'One minute left on this take - it will be split soon.'
      })
      // A tone rather than a spoken phrase: the alert plays while the
      // microphone is still live, and a beep transcribes to nothing whereas
      // words end up as text in the very step being warned about.
      this.dictation.beep('warning')
    })

    this.dictation.on('limit', () => {
      this.dictation.beep('limit')
      void this.rollSegment()
    })
  }

  /**
   * Close the current segment at the time limit and immediately open another,
   * so a long explanation becomes several steps instead of stopping the author
   * dead.
   */
  private async rollSegment(): Promise<void> {
    if (!this.dictation.isRecording) return

    await this.stopDictation()
    try {
      await this.dictation.beginSegment()
      this.recorder.setState('listening', { transcript: 'New step started - keep going.' })
      this.events.toast('info', 'Four minutes reached, so that became its own step.')
    } catch {
      this.recorder.setState('idle')
    }
  }

  async init(): Promise<void> {
    await this.snipIngest.start()
  }

  /** Point audio capture at the open project, and forget any previous session's open step. */
  onProjectChanged(): void {
    const project = this.store.current
    this.cancelRefinement()
    this.snipIngest.abort()
    this.dictation.setAudioDir(project ? audioDir(project) : null)
    this.whisper.configure({ vocabulary: project?.meta.vocabulary ?? [] })
    this.recorder.resetSession()
    if (project) void this.sweepAudio(project)
  }

  /**
   * Remove recordings no step still refers to, and the folder itself when it
   * ends up empty.
   *
   * Quitting mid-transcription would otherwise strand a WAV forever, and the
   * folder lingers because dictation has to write the file before it can be
   * transcribed. Running this on open means a project tidies itself up rather
   * than accumulating audio the author was told would be deleted.
   */
  async sweepAudio(project: LoadedProject): Promise<number> {
    const dir = audioDir(project)

    let files: string[]
    try {
      files = await fs.readdir(dir)
    } catch {
      return 0
    }

    const referenced = new Set(
      project.steps.map((step) => step.audio?.file).filter((f): f is string => !!f)
    )

    let removed = 0
    for (const file of files) {
      if (referenced.has(file)) continue
      try {
        await fs.rm(join(dir, file), { force: true })
        removed += 1
      } catch {
        /* locked by a sync client; it will be caught on the next open */
      }
    }

    if (referenced.size === 0) {
      try {
        const remaining = await fs.readdir(dir)
        if (remaining.length === 0) await fs.rmdir(dir)
      } catch {
        /* the folder is either gone or held open; neither matters */
      }
    }

    return removed
  }

  private requireProject(): boolean {
    if (this.store.current) return true
    this.events.toast('warning', 'Create or open a guide project first.')
    return false
  }

  // -------------------------------------------------------------------------
  // Dictation
  // -------------------------------------------------------------------------

  async toggleDictation(): Promise<void> {
    if (!this.requireProject()) return

    if (this.dictation.isRecording) {
      await this.stopDictation()
      return
    }

    try {
      await this.dictation.beginSegment()
      this.recorder.setState('listening', { transcript: '' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.recorder.setState('error', { message })
      this.events.toast('error', message)
    }
  }

  /** Finalise the current segment and hand it to Whisper. Safe to call when idle. */
  private async stopDictation(): Promise<void> {
    if (!this.dictation.isRecording) return

    const segment = await this.dictation.endSegment()
    if (!segment) {
      this.recorder.setState(this.inFlightTranscriptions > 0 ? 'transcribing' : 'idle')
      return
    }

    const stepId = this.recorder.beginNarration(segment.file)
    this.inFlightTranscriptions += 1
    this.recorder.setState('transcribing')

    void this.transcribe(stepId, segment.absolutePath, segment.durationMs)
  }

  private async transcribe(stepId: string, wavPath: string, durationMs: number): Promise<void> {
    try {
      const { text, engine } = await this.whisper.transcribe(wavPath)
      if (text) {
        this.recorder.completeNarration(stepId, text, { engine, durationMs })
        this.recorder.setTranscript(text)
        await this.discardAudio(stepId)
      } else {
        this.recorder.failNarration(stepId)
      }
    } catch (err) {
      this.recorder.failNarration(stepId)
      const message = err instanceof Error ? err.message : String(err)
      // The audio is deliberately *kept* when transcription fails, so this is a
      // degraded mode and not a lost take: the author can type the step, or
      // install the engine and re-transcribe later.
      this.events.toast(
        'warning',
        `Saved the audio but could not transcribe it. ${message}`
      )
    } finally {
      this.inFlightTranscriptions -= 1
      if (!this.dictation.isRecording && this.inFlightTranscriptions <= 0) {
        this.recorder.setState('idle')
      }
    }
  }

  /**
   * Delete a step's WAV once its words are safely in the transcript.
   *
   * The transcript is the artefact that matters; keeping every recording would
   * bloat a project by hundreds of megabytes for no benefit. Audio is retained
   * only where transcription did *not* succeed, which is exactly the case where
   * throwing it away would lose the take.
   */
  private async discardAudio(stepId: string): Promise<void> {
    const project = this.store.current
    if (!project) return

    const file = this.recorder.takeAudio(stepId)
    if (!file) return

    await fs.rm(join(audioDir(project), file), { force: true }).catch(() => undefined)

    // Dictation has to write the WAV before it can be transcribed, so the
    // folder appears even on the happy path. Sweeping removes it once nothing
    // is left, so a project only carries audio/ when it actually holds audio.
    await this.sweepAudio({ ...project, steps: this.store.current?.steps ?? project.steps })
  }

  /** Microphones the author can dictate from. */
  inputDevices(): Array<{ id: string; label: string }> {
    return this.dictation.inputDevices
  }

  setInputDevice(deviceId: string | undefined): void {
    this.dictation.setDevice(deviceId)
  }

  refreshInputDevices(): void {
    this.dictation.refreshDevices()
  }

  /**
   * Re-run transcription over audio that was already captured.
   *
   * This is what makes a missing engine a recoverable inconvenience rather than
   * lost work: the WAV for every dictation segment is kept, so installing
   * whisper.cpp afterwards rescues everything that was narrated before it.
   */
  async retranscribe(stepId?: string): Promise<{
    attempted: number
    succeeded: number
    failed: number
    error?: string
  }> {
    const project = this.store.current
    if (!project) return { attempted: 0, succeeded: 0, failed: 0, error: 'No project is open.' }

    const available = await this.whisper.availability()
    if (!available.ok) {
      return { attempted: 0, succeeded: 0, failed: 0, error: available.reason }
    }

    const candidates = project.steps.filter((step) => {
      if (!step.audio?.file) return false
      if (stepId) return step.id === stepId
      // Without an explicit step, only fill in the ones that came back empty -
      // never overwrite narration the author has already edited.
      return !step.narration.trim()
    })

    if (candidates.length === 0) {
      return { attempted: 0, succeeded: 0, failed: 0, error: 'No audio to re-transcribe.' }
    }

    let succeeded = 0
    let failed = 0

    this.recorder.setState('transcribing')

    for (const step of candidates) {
      try {
        const { text, engine } = await this.whisper.transcribe(
          audioPath(project, step.audio!.file)
        )
        if (text) {
          // completeNarration appends, so clear first to avoid duplicating text
          // when re-running against a step that already has some.
          this.recorder.replaceNarration(step.id, text, engine)
          await this.discardAudio(step.id)
          succeeded += 1
        } else {
          failed += 1
        }
      } catch {
        failed += 1
      }
    }

    this.recorder.setState('idle')
    return { attempted: candidates.length, succeeded, failed }
  }

  // -------------------------------------------------------------------------
  // Snip
  // -------------------------------------------------------------------------

  /**
   * Run a snip.
   *
   * With `targetStepId` the screenshot is appended to that existing step rather
   * than driving the capture flow - that is the path used when the author
   * clicks a step's image slot in the storyboard.
   */
  async snip(targetStepId?: string): Promise<void> {
    if (!this.requireProject()) return

    // A pending snip must never block a new one. We cannot tell Escape apart
    // from "still deciding" (Windows keeps SnippingTool alive either way), so
    // pressing the hotkey again always wins.
    if (this.snipIngest.isCapturing) {
      this.snipIngest.abort()
      this.events.toast('info', 'Restarted the snip.')
    }
    this.cancelRefinement()

    // Order matters: finalise narration first so it lands before the image.
    const wasDictating = this.dictation.isRecording
    if (wasDictating && !targetStepId) await this.stopDictation()

    // Grab context *before* the snip overlay steals the foreground.
    const context = targetStepId ? undefined : await this.captureContext()

    this.recorder.setState('capturing')

    try {
      const project = this.store.current
      if (!project) return

      const { result, baseline } = await this.snipIngest.capture({
        mediaDir: mediaDir(project)
      })

      if (!result) {
        this.recorder.setState('idle')
        this.events.toast('info', 'No screenshot arrived - snip cancelled or timed out.')
      } else {
        const imageId = targetStepId
          ? this.recorder.addImageToStep(targetStepId, {
              file: result.file,
              width: result.width,
              height: result.height
            })
          : this.recorder.attachImage(
              { file: result.file, width: result.width, height: result.height },
              context
            ).imageId

        this.recorder.setState('captured', {
          transcript: 'Captured. Annotate and copy or save to replace it.'
        })
        // Windows put the *raw* selection on the clipboard the moment the region
        // was drawn, so this first image can never be the annotated one.
        if (imageId) this.watchForAnnotation(imageId, baseline)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.recorder.setState('error', { message })
      this.events.toast('error', message)
    } finally {
      if (wasDictating && !this.dictation.isRecording) {
        // Auto-resume so the author can keep talking without a second hotkey.
        try {
          await this.dictation.beginSegment()
          this.recorder.setState('listening')
        } catch {
          this.recorder.setState('idle')
        }
      } else if (this.recorder.state === 'captured') {
        setTimeout(() => {
          if (this.recorder.state === 'captured') this.recorder.setState('idle')
        }, 2500)
      }
    }
  }

  /**
   * Watch for the annotated version of the screenshot we just attached.
   *
   * The Win+Shift+S overlay only selects a region - annotation happens
   * afterwards in the Snipping Tool editor, and only reaches us when the author
   * presses Copy or Save. So for a short window after a capture, any newer
   * image quietly replaces the one on the step.
   */
  private watchForAnnotation(imageId: string, baseline: ClipboardBaseline): void {
    const project = this.store.current
    if (!project) return

    this.refinementImageId = imageId

    void (async () => {
      try {
        const better = await this.snipIngest.waitForNewer(baseline, {
          mediaDir: mediaDir(project),
          timeoutMs: ANNOTATION_GRACE_MS
        })

        if (!better) return

        // The author may have moved on while we waited - a new snip, an undo,
        // a deleted step, a closed project. In every one of those cases the
        // newer image is no longer wanted and must not be left on disk.
        if (this.refinementImageId !== imageId || !this.recorder.findImage(imageId)) {
          await this.discard(project, better.file)
          return
        }

        const previous = this.recorder.replaceImage(imageId, {
          file: better.file,
          width: better.width,
          height: better.height
        })

        if (previous) await this.discard(project, previous)
        this.events.toast('success', 'Updated the step with your annotated screenshot.')
      } catch {
        // Refinement is a bonus; the original screenshot is already safe.
      } finally {
        if (this.refinementImageId === imageId) this.refinementImageId = null
      }
    })()
  }

  /**
   * Stop watching for an annotated replacement.
   *
   * Aborts the poll as well as clearing the target, so this is safe to call on
   * its own - relying on every caller to also abort would be a trap.
   */
  private cancelRefinement(): void {
    if (this.refinementImageId === null) return
    this.refinementImageId = null
    this.snipIngest.abort()
  }

  private async discard(project: LoadedProject, file: string): Promise<void> {
    await fs.rm(mediaPath(project, file), { force: true }).catch(() => undefined)
  }

  private async captureContext(): Promise<CaptureContext> {
    const context = await this.platform.activeWindow()
    try {
      const point = screen.getCursorScreenPoint()
      context.cursor = { x: point.x, y: point.y }
    } catch {
      /* cursor position is a bonus, not a requirement */
    }
    return context
  }

  // -------------------------------------------------------------------------
  // Other hotkeys
  // -------------------------------------------------------------------------

  async scratch(): Promise<void> {
    if (!this.requireProject()) return
    this.cancelRefinement()
    this.snipIngest.abort()
    const dropped = await this.recorder.scratch()
    this.events.toast(
      dropped ? 'info' : 'warning',
      dropped ? 'Dropped the last step.' : 'Nothing to drop.'
    )
  }

  async sectionBreak(): Promise<void> {
    if (!this.requireProject()) return
    // Close the current segment so the break falls cleanly between two steps.
    const wasDictating = this.dictation.isRecording
    if (wasDictating) await this.stopDictation()

    this.recorder.sectionBreak()
    this.events.toast('info', 'Section break marked.')

    if (wasDictating) {
      try {
        await this.dictation.beginSegment()
        this.recorder.setState('listening')
      } catch {
        this.recorder.setState('idle')
      }
    }
  }

  async clipboardCode(): Promise<void> {
    if (!this.requireProject()) return
    const text = clipboard.readText().trim()
    if (!text) {
      this.events.toast('warning', 'The clipboard has no text in it.')
      return
    }
    this.recorder.addCode({ text, lang: guessLang(text) })
    this.events.toast('success', 'Clipboard captured as a code block.')
  }

  async dispose(): Promise<void> {
    this.dictation.dispose()
    await this.snipIngest.dispose()
  }
}

/** A rough guess is plenty: the author can change it, and the AI sees the text anyway. */
function guessLang(text: string): string | undefined {
  const t = text.trim()
  if (/^(az|azd|winget|choco|npm|npx|yarn|pnpm|dotnet|git|kubectl|helm|docker|mvn|gradle)\s/.test(t)) {
    return 'bash'
  }
  if (/^(Get-|Set-|New-|Remove-|Install-|Import-|\$\w+\s*=)/.test(t)) return 'powershell'
  if (/^[{[][\s\S]*[}\]]$/.test(t)) return 'json'
  if (/^(SELECT|INSERT|UPDATE|DELETE|CREATE)\s/i.test(t)) return 'sql'
  if (/^(package|import|public\s+class)\s/.test(t)) return 'java'
  if (/^(def|class|from|import)\s/.test(t)) return 'python'
  return undefined
}
