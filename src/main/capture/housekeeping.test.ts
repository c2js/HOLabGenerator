import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CaptureController } from './controller'
import { Recorder } from './recorder'
import { ProjectStore, createProject, audioDir } from '../project/store'
import { WhisperEngine } from './whisper'
import type { PlatformAdapter } from '../platform'
import type { CaptureContext, LoadedProject } from '@shared/types'

let dir: string
let project: LoadedProject
let store: ProjectStore
let controller: CaptureController

function fakePlatform(): PlatformAdapter {
  return {
    id: 'win32',
    snipToolName: 'Fake',
    screenshotsDir: () => join(dir, 'shots'),
    triggerSnip: async () => undefined,
    activeWindow: async (): Promise<CaptureContext> => ({}),
    clipboardSequence: async () => 1,
    dispose: () => undefined
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wc-sweep-'))
  project = await createProject(dir, 'Sweep Test', 'CI', { scaffold: false })
  store = new ProjectStore()
  store.set(project)
  controller = new CaptureController(
    store,
    new Recorder(store),
    fakePlatform(),
    new WhisperEngine(),
    { toast: () => undefined }
  )
})

afterEach(async () => {
  await controller.dispose()
  store.dispose()
  await rm(dir, { recursive: true, force: true })
})

describe('audio housekeeping', () => {
  it('does not create an audio folder up front', async () => {
    expect(await exists(audioDir(store.current!))).toBe(false)
  })

  it('deletes recordings no step refers to', async () => {
    const audio = audioDir(store.current!)
    await mkdir(audio, { recursive: true })
    await writeFile(join(audio, 'orphan-a.wav'), 'x')
    await writeFile(join(audio, 'orphan-b.wav'), 'x')

    // Quitting mid-transcription is exactly how these get stranded.
    const removed = await controller.sweepAudio(store.current!)

    expect(removed).toBe(2)
    expect(await exists(join(audio, 'orphan-a.wav'))).toBe(false)
  })

  it('removes the folder once nothing is left in it', async () => {
    const audio = audioDir(store.current!)
    await mkdir(audio, { recursive: true })
    await writeFile(join(audio, 'orphan.wav'), 'x')

    await controller.sweepAudio(store.current!)

    expect(await exists(audio)).toBe(false)
  })

  it('keeps recordings a step still needs for re-transcription', async () => {
    const audio = audioDir(store.current!)
    await mkdir(audio, { recursive: true })
    await writeFile(join(audio, 'keep.wav'), 'x')
    await writeFile(join(audio, 'drop.wav'), 'x')

    store.setSteps([
      {
        id: 's1',
        narration: '',
        at: new Date().toISOString(),
        audio: { file: 'keep.wav' }
      }
    ])

    const removed = await controller.sweepAudio(store.current!)

    expect(removed).toBe(1)
    expect(await exists(join(audio, 'keep.wav'))).toBe(true)
    // The folder must survive while it still holds an unrecovered take.
    expect(await exists(audio)).toBe(true)
  })

  it('is a no-op when there is no audio folder at all', async () => {
    expect(await controller.sweepAudio(store.current!)).toBe(0)
  })
})
