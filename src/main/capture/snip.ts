import { promises as fs } from 'node:fs'
import { join, extname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { clipboard, nativeImage } from 'electron'
import chokidar, { type FSWatcher } from 'chokidar'
import type { PlatformAdapter } from '../platform'

export interface SnipResult {
  /** Filename inside the project's media/ folder. */
  file: string
  width: number
  height: number
  source: 'clipboard' | 'folder'
}

/** A point-in-time fingerprint of the clipboard, used to spot a *newer* image. */
export interface ClipboardBaseline {
  sequence: number | null
  hash: string | null
  since: number
}

export interface CaptureOptions {
  /** Absolute path of the project's media/ folder. */
  mediaDir: string
  timeoutMs?: number
}

const POLL_MS = 300
const DEFAULT_TIMEOUT_MS = 90_000
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp'])

class Aborted extends Error {
  constructor() {
    super('Capture aborted')
  }
}

/**
 * Ingests the result of a native snip.
 *
 * Two paths are watched at once because authors reach for whichever they
 * already use:
 *
 *   1. the clipboard - Win+Shift+S, the common case
 *   2. the OS screenshots folder - Win+PrtScn, or Snipping Tool's Save
 *
 * We never implement capture or annotation ourselves, so whatever arrives is
 * already annotated and redacted exactly as the author left it.
 *
 * Cancellation is deliberately *not* detected. Windows keeps several
 * SnippingTool processes alive with non-zero window handles even when nothing
 * is on screen, so neither process presence nor window handles distinguish "the
 * overlay is open" from "the user pressed Escape". Rather than guess wrong, a
 * pending capture is abortable and a new snip always supersedes it.
 */
export class SnipIngest {
  private watcher: FSWatcher | null = null
  private recentFiles: Array<{ path: string; at: number }> = []
  private aborting: (() => void) | null = null
  private busy = false

  constructor(private readonly platform: PlatformAdapter) {}

  /** Start watching the OS screenshots folder. Safe to call when it does not exist yet. */
  async start(): Promise<void> {
    if (this.watcher) return
    const dir = this.platform.screenshotsDir()

    try {
      await fs.mkdir(dir, { recursive: true })
    } catch {
      // A missing, uncreatable folder just means the clipboard path is the only one.
    }

    this.watcher = chokidar.watch(dir, {
      ignoreInitial: true,
      depth: 0,
      // Snipping Tool writes progressively; wait until the file stops growing
      // or we would read a half-written PNG.
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 }
    })

    this.watcher.on('add', (path: string) => {
      if (!IMAGE_EXT.has(extname(path).toLowerCase())) return
      this.recentFiles.push({ path, at: Date.now() })
      if (this.recentFiles.length > 40) this.recentFiles.shift()
    })

    this.watcher.on('error', () => {
      /* watching is best-effort */
    })
  }

  get isCapturing(): boolean {
    return this.busy
  }

  /** Abort whatever capture or refinement wait is in flight. */
  abort(): void {
    this.aborting?.()
    this.aborting = null
  }

  /** Fingerprint the clipboard so we can later tell "changed" from "unchanged". */
  async baseline(): Promise<ClipboardBaseline> {
    const sequence = await this.platform.clipboardSequence()
    return {
      sequence,
      hash: sequence === null ? clipboardHash() : null,
      since: Date.now()
    }
  }

  /**
   * Summon the native snip UI and wait for an image.
   *
   * Resolves null if aborted, or if nothing arrives before the timeout - which
   * is also what an Escape looks like from here.
   *
   * The returned baseline is taken *after* the image is accepted, not before
   * the trigger. Refinement compares against "the clipboard as it stands now
   * that we have the raw selection", otherwise the very image we just ingested
   * would immediately look like a newer one and replace itself.
   */
  async capture(
    opts: CaptureOptions
  ): Promise<{ result: SnipResult | null; baseline: ClipboardBaseline }> {
    this.abort()

    const before = await this.baseline()
    this.recentFiles = []
    this.busy = true

    try {
      await this.platform.triggerSnip()
      const result = await this.waitForImage(before, opts)
      return { result, baseline: result ? await this.baseline() : before }
    } finally {
      this.busy = false
    }
  }

  /**
   * Wait for an image *newer* than the given baseline, without triggering a snip.
   *
   * This is what captures annotation. Windows puts the raw selection on the
   * clipboard the instant the region is drawn - before the author has had any
   * chance to draw an arrow on it - so the first image we see is never the
   * annotated one. Watching for a second, later image lets Copy or Save from
   * the Snipping Tool editor quietly replace it.
   */
  async waitForNewer(baseline: ClipboardBaseline, opts: CaptureOptions): Promise<SnipResult | null> {
    this.abort()
    return this.waitForImage(baseline, opts)
  }

  private async waitForImage(
    baseline: ClipboardBaseline,
    opts: CaptureOptions
  ): Promise<SnipResult | null> {
    const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    let aborted = false
    this.aborting = () => {
      aborted = true
    }

    try {
      while (Date.now() < deadline) {
        await delay(POLL_MS)
        if (aborted) throw new Aborted()

        const fromClipboard = await this.tryClipboard(baseline, opts.mediaDir)
        if (fromClipboard) return fromClipboard

        const fromFolder = await this.tryFolder(baseline.since, opts.mediaDir)
        if (fromFolder) return fromFolder
      }
      return null
    } catch (err) {
      if (err instanceof Aborted) return null
      throw err
    } finally {
      this.aborting = null
    }
  }

  private async tryClipboard(
    baseline: ClipboardBaseline,
    mediaDir: string
  ): Promise<SnipResult | null> {
    if (baseline.sequence !== null) {
      const sequence = await this.platform.clipboardSequence()
      if (sequence === null || sequence === baseline.sequence) return null
    }

    const image = clipboard.readImage()
    if (image.isEmpty()) return null

    if (baseline.sequence === null) {
      const hash = clipboardHash()
      if (!hash || hash === baseline.hash) return null
    }

    const { width, height } = image.getSize()
    if (width === 0 || height === 0) return null

    const file = `${stamp()}-${randomUUID().slice(0, 8)}.png`
    await fs.writeFile(join(mediaDir, file), image.toPNG())
    return { file, width, height, source: 'clipboard' }
  }

  private async tryFolder(since: number, mediaDir: string): Promise<SnipResult | null> {
    const entry = this.recentFiles.find((f) => f.at >= since)
    if (!entry) return null
    this.recentFiles = this.recentFiles.filter((f) => f !== entry)

    try {
      const image = nativeImage.createFromPath(entry.path)
      if (image.isEmpty()) return null

      const { width, height } = image.getSize()
      const ext = extname(entry.path).toLowerCase() || '.png'
      const file = `${stamp()}-${randomUUID().slice(0, 8)}${ext}`
      await fs.copyFile(entry.path, join(mediaDir, file))
      return { file, width, height, source: 'folder' }
    } catch {
      return null
    }
  }

  async dispose(): Promise<void> {
    this.abort()
    await this.watcher?.close()
    this.watcher = null
  }
}

function clipboardHash(): string | null {
  const image = clipboard.readImage()
  if (image.isEmpty()) return null
  return createHash('sha1').update(image.toPNG()).digest('hex')
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
