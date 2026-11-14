import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promises as fs } from 'node:fs'
import { EventEmitter } from 'node:events'
import { BrowserWindow, ipcMain } from 'electron'
import { CH } from '@shared/ipc'
import { encodeWav, pcmDurationMs } from './wav'

const __dirname = dirname(fileURLToPath(import.meta.url))
const isDev = !!process.env['ELECTRON_RENDERER_URL']

export interface SegmentResult {
  /** Filename inside the project's audio/ folder. */
  file: string
  absolutePath: string
  durationMs: number
}

/** Below this, the "segment" is almost certainly an accidental double-tap. */
const MIN_SEGMENT_MS = 350

/**
 * Hard ceiling on one dictation segment.
 *
 * Whisper's cost grows with clip length and a very long take produces one
 * enormous step that the author then has to split by hand. Cutting at four
 * minutes keeps transcription responsive and keeps steps step-sized.
 */
export const MAX_SEGMENT_MS = 4 * 60_000

/** How long before the cap the author is warned, so they can wrap up a sentence. */
export const SEGMENT_WARNING_MS = 60_000

/**
 * Owns the hidden audio host window and turns dictation segments into WAV files.
 *
 * The main process never touches audio hardware: the host window captures at
 * 16 kHz mono and hands back raw PCM, and all we do here is add a WAV header.
 */
export class Dictation extends EventEmitter {
  private host: BrowserWindow | null = null
  private hostReady: Promise<void> | null = null
  private recording = false
  private pending: ((result: SegmentResult | null) => void) | null = null
  private audioDir: string | null = null
  private counter = 0
  private lastError: string | null = null
  private startedAt: number | null = null
  private warningTimer: NodeJS.Timeout | null = null
  private limitTimer: NodeJS.Timeout | null = null
  private devices: Array<{ id: string; label: string }> = []
  /** Which microphone to open; undefined means the system default. */
  private deviceId: string | undefined

  get inputDevices(): Array<{ id: string; label: string }> {
    return this.devices
  }

  setDevice(deviceId: string | undefined): void {
    this.deviceId = deviceId || undefined
  }

  /** Ask the host to refresh its device list (labels need mic permission). */
  refreshDevices(): void {
    this.host?.webContents.send(CH.audioEnumerate)
  }

  /** Play an alert tone through the host window's audio context. */
  beep(pattern: 'warning' | 'limit'): void {
    this.host?.webContents.send(CH.audioBeep, pattern)
  }

  get isRecording(): boolean {
    return this.recording
  }

  get error(): string | null {
    return this.lastError
  }

  setAudioDir(dir: string | null): void {
    this.audioDir = dir
    this.counter = 0
  }

  /** Create the hidden host window and wait for it to report ready. */
  async start(): Promise<void> {
    if (this.hostReady) return this.hostReady

    this.hostReady = new Promise<void>((resolve, reject) => {
      const host = new BrowserWindow({
        show: false,
        width: 320,
        height: 200,
        webPreferences: {
          preload: join(__dirname, '../preload/audio.mjs'),
          sandbox: false,
          contextIsolation: true,
          nodeIntegration: false,
          // Keeps the audio graph running while the window is hidden.
          backgroundThrottling: false
        }
      })

      const timer = setTimeout(
        () => reject(new Error('The audio host did not start in time.')),
        15_000
      )

      ipcMain.once(CH.audioReady, () => {
        clearTimeout(timer)
        resolve()
      })

      host.webContents.on('render-process-gone', (_e, details) => {
        this.lastError = `Audio host crashed (${details.reason}).`
        this.emit('error', this.lastError)
        this.host = null
        this.hostReady = null
      })

      this.host = host

      const url = isDev
        ? `${process.env['ELECTRON_RENDERER_URL']}/audio.html`
        : pathToFileURL(join(__dirname, '../renderer/audio.html')).toString()
      void host.loadURL(url)
    })

    this.registerHandlers()
    return this.hostReady
  }

  private handlersRegistered = false

  private registerHandlers(): void {
    if (this.handlersRegistered) return
    this.handlersRegistered = true

    ipcMain.on(CH.audioLevel, (_e, peak: number) => this.emit('level', peak))

    ipcMain.on(CH.audioDevices, (_e, devices: Array<{ id: string; label: string }>) => {
      this.devices = devices
      this.emit('devices', devices)
    })

    ipcMain.on(CH.audioError, (_e, message: string) => {
      this.lastError = message
      this.recording = false
      const done = this.pending
      this.pending = null
      done?.(null)
      this.emit('error', message)
    })

    ipcMain.on(CH.audioSegment, (_e, payload: { pcm: Uint8Array; sampleRate: number }) => {
      void this.onSegment(payload)
    })
  }

  private async onSegment(payload: { pcm: Uint8Array; sampleRate: number }): Promise<void> {
    const done = this.pending
    this.pending = null

    try {
      const pcm = Buffer.from(payload.pcm)
      const durationMs = pcmDurationMs(pcm, payload.sampleRate)

      if (!this.audioDir || pcm.length === 0 || durationMs < MIN_SEGMENT_MS) {
        done?.(null)
        return
      }

      this.counter += 1
      const file = `segment-${String(this.counter).padStart(3, '0')}-${Date.now()}.wav`
      const absolutePath = join(this.audioDir, file)

      await fs.mkdir(this.audioDir, { recursive: true })
      await fs.writeFile(absolutePath, encodeWav(pcm, payload.sampleRate))

      done?.({ file, absolutePath, durationMs })
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      this.emit('error', this.lastError)
      done?.(null)
    }
  }

  /** Begin a dictation segment. Resolves once the host has the microphone open. */
  async beginSegment(): Promise<void> {
    if (this.recording) return
    await this.start()
    this.lastError = null
    this.recording = true
    this.startedAt = Date.now()
    this.host?.webContents.send(CH.audioStart, this.deviceId)

    // Warn first, then cut. The author gets a chance to finish their sentence
    // rather than being stopped mid-word.
    this.clearTimers()
    this.warningTimer = setTimeout(() => {
      if (this.recording) this.emit('warning', MAX_SEGMENT_MS - SEGMENT_WARNING_MS)
    }, MAX_SEGMENT_MS - SEGMENT_WARNING_MS)

    this.limitTimer = setTimeout(() => {
      if (this.recording) this.emit('limit')
    }, MAX_SEGMENT_MS)
  }

  /** Milliseconds recorded so far in the current segment. */
  get elapsedMs(): number {
    return this.recording && this.startedAt ? Date.now() - this.startedAt : 0
  }

  private clearTimers(): void {
    if (this.warningTimer) clearTimeout(this.warningTimer)
    if (this.limitTimer) clearTimeout(this.limitTimer)
    this.warningTimer = null
    this.limitTimer = null
  }

  /** End the current segment and resolve with the written WAV, or null if it was too short. */
  async endSegment(): Promise<SegmentResult | null> {
    this.clearTimers()
    this.startedAt = null
    if (!this.recording || !this.host) return null
    this.recording = false

    return new Promise<SegmentResult | null>((resolve) => {
      this.pending = resolve
      this.host?.webContents.send(CH.audioStop)
      // Never hang the recorder if the host goes silent on us.
      setTimeout(() => {
        if (this.pending === resolve) {
          this.pending = null
          resolve(null)
        }
      }, 10_000)
    })
  }

  dispose(): void {
    this.clearTimers()
    try {
      this.host?.destroy()
    } catch {
      /* already gone */
    }
    this.host = null
    this.hostReady = null
  }
}
