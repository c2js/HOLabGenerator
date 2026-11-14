import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SnipIngest } from './snip'
import { __setClipboardImage } from '../../test/electron-stub'
import type { PlatformAdapter } from '../platform'
import type { CaptureContext } from '@shared/types'

let mediaDir: string
let ingest: SnipIngest
let triggered = 0
let sequence = 1

/** Stands in for Windows: a clipboard change counter we can drive by hand. */
function fakePlatform(): PlatformAdapter {
  return {
    id: 'win32',
    snipToolName: 'Fake Snip',
    screenshotsDir: () => join(mediaDir, 'shots'),
    triggerSnip: async () => {
      triggered += 1
    },
    activeWindow: async (): Promise<CaptureContext> => ({}),
    clipboardSequence: async () => sequence,
    dispose: () => undefined
  }
}

/** A tiny but valid PNG payload; content only needs to differ between "images". */
function png(marker: string): Buffer {
  return Buffer.from(`fake-png-${marker}`)
}

function putOnClipboard(marker: string, width = 800, height = 600): void {
  __setClipboardImage({ png: png(marker), width, height })
  sequence += 1
}

beforeEach(async () => {
  mediaDir = await mkdtemp(join(tmpdir(), 'wc-snip-'))
  triggered = 0
  sequence = 1
  __setClipboardImage(null)
  ingest = new SnipIngest(fakePlatform())
})

afterEach(async () => {
  await ingest.dispose()
  await rm(mediaDir, { recursive: true, force: true })
  __setClipboardImage(null)
})

describe('capture', () => {
  it('summons the native snip tool and ingests what lands on the clipboard', async () => {
    const pending = ingest.capture({ mediaDir, timeoutMs: 4000 })
    setTimeout(() => putOnClipboard('first'), 350)

    const { result } = await pending

    expect(triggered).toBe(1)
    expect(result).not.toBeNull()
    expect(result!.source).toBe('clipboard')
    expect(result!.width).toBe(800)
    expect(await readdir(mediaDir)).toContain(result!.file)
  })

  it('ignores a clipboard that never changes, which is what Escape looks like', async () => {
    // Something unrelated was already on the clipboard before the snip.
    putOnClipboard('pre-existing')

    const { result } = await ingest.capture({ mediaDir, timeoutMs: 1200 })

    expect(result).toBeNull()
  })

  it('resolves promptly when aborted rather than blocking the next snip', async () => {
    const started = Date.now()
    const pending = ingest.capture({ mediaDir, timeoutMs: 30_000 })
    setTimeout(() => ingest.abort(), 400)

    const { result } = await pending

    expect(result).toBeNull()
    expect(Date.now() - started).toBeLessThan(5000)
    expect(ingest.isCapturing).toBe(false)
  })

  it('lets a second snip supersede one that is still waiting', async () => {
    const first = ingest.capture({ mediaDir, timeoutMs: 30_000 })
    await delay(400)

    // This is the case that used to wedge: pressing the hotkey again after
    // escaping the overlay.
    const second = ingest.capture({ mediaDir, timeoutMs: 4000 })
    setTimeout(() => putOnClipboard('second-attempt'), 350)

    const firstResult = await first
    const secondResult = await second

    expect(firstResult.result).toBeNull()
    expect(secondResult.result).not.toBeNull()
    expect(triggered).toBe(2)
  })
})

describe('waitForNewer - capturing annotation', () => {
  it('does not mistake the raw selection for an annotated replacement', async () => {
    const capture = ingest.capture({ mediaDir, timeoutMs: 4000 })
    setTimeout(() => putOnClipboard('raw'), 350)
    const { result: raw, baseline } = await capture

    expect(raw).not.toBeNull()

    // Nothing further is copied. The baseline handed back must already account
    // for the image we just took, or it would replace itself immediately.
    const again = await ingest.waitForNewer(baseline, { mediaDir, timeoutMs: 1500 })

    expect(again).toBeNull()
    // And no stray duplicate should have been written to disk.
    expect((await readdir(mediaDir)).filter((f) => f.endsWith('.png'))).toHaveLength(1)
  })

  it('picks up an annotated image copied after the raw selection', async () => {
    // Windows puts the raw selection on the clipboard immediately.
    const capture = ingest.capture({ mediaDir, timeoutMs: 4000 })
    setTimeout(() => putOnClipboard('raw'), 350)
    const { result: raw, baseline } = await capture

    expect(raw).not.toBeNull()

    // The author then annotates in the Snipping Tool editor and presses Copy.
    const refinement = ingest.waitForNewer(baseline, { mediaDir, timeoutMs: 4000 })
    setTimeout(() => putOnClipboard('annotated', 1200, 900), 350)

    const annotated = await refinement

    expect(annotated).not.toBeNull()
    expect(annotated!.width).toBe(1200)
    expect(annotated!.file).not.toBe(raw!.file)
  })

  it('returns nothing when the author never annotates', async () => {
    const baseline = await ingest.baseline()
    const annotated = await ingest.waitForNewer(baseline, { mediaDir, timeoutMs: 1200 })

    expect(annotated).toBeNull()
  })

  it('stops waiting for annotation as soon as it is aborted', async () => {
    const baseline = await ingest.baseline()
    const started = Date.now()
    const pending = ingest.waitForNewer(baseline, { mediaDir, timeoutMs: 30_000 })
    setTimeout(() => ingest.abort(), 400)

    expect(await pending).toBeNull()
    expect(Date.now() - started).toBeLessThan(5000)
  })
})

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
