import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Recorder } from './recorder'
import { ProjectStore, createProject, MEDIA_DIR, AUDIO_DIR, pathExists } from '../project/store'
import type { LoadedProject } from '@shared/types'

let dir: string
let project: LoadedProject
let store: ProjectStore
let recorder: Recorder

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wc-test-'))
  // No scaffolding: these tests exercise the step model, not the file layout.
  project = await createProject(dir, 'Test Guide', 'Tester', { scaffold: false })
  store = new ProjectStore()
  store.set(project)
  recorder = new Recorder(store)
})

afterEach(async () => {
  // Stop the debounced save before the folder goes, or it fires into nothing.
  store.dispose()
  await rm(dir, { recursive: true, force: true })
})

const steps = (): LoadedProject['steps'] => store.current!.steps

function img(file: string): { file: string; width: number; height: number } {
  return { file, width: 800, height: 600 }
}

describe('step assembly rules', () => {
  it('collapses narration and the screenshot that follows into one step', () => {
    recorder.addNarration('go to the left hand side')
    recorder.attachImage(img('a.png'))

    expect(steps()).toHaveLength(1)
    expect(steps()[0].narration).toBe('go to the left hand side')
    expect(steps()[0].images?.[0]?.file).toBe('a.png')
  })

  it('starts a new step when narration follows a step that already has an image', () => {
    recorder.addNarration('first')
    recorder.attachImage(img('a.png'))
    recorder.addNarration('second')

    expect(steps()).toHaveLength(2)
    expect(steps()[1].narration).toBe('second')
    expect(steps()[1].images ?? []).toHaveLength(0)
  })

  it('appends consecutive narration into the same open step', () => {
    recorder.addNarration('open the portal')
    recorder.addNarration('then sign in')

    expect(steps()).toHaveLength(1)
    expect(steps()[0].narration).toBe('open the portal then sign in')
  })

  it('creates a step for a screenshot taken with no narration', () => {
    recorder.attachImage(img('a.png'))

    expect(steps()).toHaveLength(1)
    expect(steps()[0].narration).toBe('')
    expect(steps()[0].images?.[0]?.file).toBe('a.png')
  })

  it('attaches a clipboard capture to the open step', () => {
    recorder.addNarration('run this command')
    recorder.addCode({ text: 'az login', lang: 'bash' })

    expect(steps()[0].code?.text).toBe('az login')
  })
})

describe('image tokens', () => {
  it('numbers tokens in document order', () => {
    recorder.addNarration('one')
    recorder.attachImage(img('a.png'))
    recorder.addNarration('two')
    recorder.attachImage(img('b.png'))

    expect(steps().map((s) => s.images?.[0]?.token)).toEqual(['step-001', 'step-002'])
  })

  it('renumbers after a step is dropped so tokens stay contiguous', async () => {
    recorder.addNarration('one')
    recorder.attachImage(img('a.png'))
    recorder.addNarration('two')
    recorder.attachImage(img('b.png'))
    recorder.addNarration('three')
    recorder.attachImage(img('c.png'))

    await recorder.scratch()

    expect(steps()).toHaveLength(2)
    expect(steps().map((s) => s.images?.[0]?.token)).toEqual(['step-001', 'step-002'])
  })

  it('skips steps with no image when numbering', () => {
    recorder.addNarration('talk only')
    recorder.sectionBreak()
    recorder.addNarration('now look')
    recorder.attachImage(img('a.png'))

    expect(steps()).toHaveLength(2)
    expect(steps()[0].images ?? []).toHaveLength(0)
    expect(steps()[1].images?.[0]?.token).toBe('step-001')
  })
})

describe('section breaks', () => {
  it('marks the open step when it is still empty', () => {
    recorder.sectionBreak('Setup')
    recorder.addNarration('intro')

    expect(steps()).toHaveLength(1)
    expect(steps()[0].sectionBreakBefore).toBe(true)
    expect(steps()[0].sectionTitle).toBe('Setup')
  })

  it('starts a new step after a section break so narration does not merge across the boundary', () => {
    recorder.addNarration('that finishes the setup')
    recorder.sectionBreak('Assess the app')
    recorder.addNarration('now we assess')

    expect(steps()).toHaveLength(2)
    expect(steps()[0].narration).toBe('that finishes the setup')
    expect(steps()[1].narration).toBe('now we assess')
    expect(steps()[1].sectionBreakBefore).toBe(true)
    expect(steps()[1].sectionTitle).toBe('Assess the app')
  })

  it('reuses an empty open step rather than stranding a blank card', () => {
    recorder.sectionBreak('Setup')
    recorder.sectionBreak('Setup again')
    recorder.addNarration('first line')

    expect(steps()).toHaveLength(1)
    expect(steps()[0].sectionBreakBefore).toBe(true)
    expect(steps()[0].narration).toBe('first line')
  })

  it('defers to the next step when the previous step is already closed', () => {
    recorder.addNarration('one')
    recorder.attachImage(img('a.png'))
    recorder.sectionBreak()
    recorder.addNarration('two')

    expect(steps()[0].sectionBreakBefore).toBeUndefined()
    expect(steps()[1].sectionBreakBefore).toBe(true)
  })
})

describe('session boundaries', () => {
  it('does not append to a previous session\'s step after reopening a project', () => {
    recorder.addNarration('captured yesterday')
    recorder.resetSession()
    recorder.addNarration('captured today')

    expect(steps()).toHaveLength(2)
  })
})

describe('replacing a screenshot with its annotated version', () => {
  it('keeps the token, caption and position, and reports the file to delete', () => {
    recorder.addNarration('click create agent')
    const first = recorder.attachImage(img('raw.png'))

    recorder.addNarration('next thing')
    recorder.attachImage(img('second.png'))

    // Caption the first screenshot, as an author reviewing might.
    store.setSteps(
      steps().map((s) =>
        s.id === first.stepId
          ? { ...s, images: s.images!.map((i) => ({ ...i, caption: 'The agent blade' })) }
          : s
      )
    )

    const previous = recorder.replaceImage(first.imageId, {
      file: 'annotated.png',
      width: 1200,
      height: 800
    })

    const updated = steps().find((s) => s.id === first.stepId)!.images![0]
    expect(previous).toBe('raw.png')
    expect(updated.file).toBe('annotated.png')
    expect(updated.width).toBe(1200)
    // The token must not shift, or the AI's already-written HTML would break.
    expect(updated.token).toBe('step-001')
    expect(updated.caption).toBe('The agent blade')
    expect(steps()[1].images?.[0]?.token).toBe('step-002')
  })

  it('does nothing for an image id that is not in the project', () => {
    recorder.addNarration('talking only')

    expect(recorder.replaceImage('nope', { file: 'x.png', width: 1, height: 1 })).toBeNull()
    expect(steps()[0].images ?? []).toHaveLength(0)
  })

  it('does not ask to delete the file it just installed', () => {
    recorder.addNarration('one')
    const { imageId } = recorder.attachImage(img('same.png'))

    expect(recorder.replaceImage(imageId, { file: 'same.png', width: 10, height: 10 })).toBeNull()
  })

  it('returns the step and image the screenshot landed on', () => {
    recorder.addNarration('one')
    const { stepId, imageId } = recorder.attachImage(img('a.png'))

    expect(stepId).toBe(steps()[0].id)
    expect(recorder.findImage(imageId)?.image.file).toBe('a.png')
  })
})

describe('several screenshots on one step', () => {
  it('appends to an existing step without disturbing the capture flow', () => {
    recorder.addNarration('open the dialog')
    const { stepId } = recorder.attachImage(img('menu.png'))

    const second = recorder.addImageToStep(stepId, {
      file: 'dialog.png',
      width: 400,
      height: 300
    })

    expect(second).not.toBeNull()
    expect(steps()).toHaveLength(1)
    expect(steps()[0].images?.map((i) => i.file)).toEqual(['menu.png', 'dialog.png'])
    // Tokens stay contiguous across images, not just across steps.
    expect(steps()[0].images?.map((i) => i.token)).toEqual(['step-001', 'step-002'])
  })

  it('numbers tokens across steps and images in document order', () => {
    recorder.addNarration('one')
    const first = recorder.attachImage(img('a.png'))
    recorder.addImageToStep(first.stepId, { file: 'b.png', width: 1, height: 1 })

    recorder.addNarration('two')
    recorder.attachImage(img('c.png'))

    expect(steps()[0].images?.map((i) => i.token)).toEqual(['step-001', 'step-002'])
    expect(steps()[1].images?.map((i) => i.token)).toEqual(['step-003'])
  })

  it('renumbers after one image is removed', () => {
    recorder.addNarration('one')
    const first = recorder.attachImage(img('a.png'))
    const secondId = recorder.addImageToStep(first.stepId, {
      file: 'b.png',
      width: 1,
      height: 1
    })!
    recorder.addNarration('two')
    recorder.attachImage(img('c.png'))

    expect(recorder.removeImage(secondId)).toBe('b.png')
    expect(steps()[0].images?.map((i) => i.token)).toEqual(['step-001'])
    expect(steps()[1].images?.map((i) => i.token)).toEqual(['step-002'])
  })

  it('refuses to add an image to a step that does not exist', () => {
    expect(recorder.addImageToStep('nope', { file: 'x.png', width: 1, height: 1 })).toBeNull()
  })
})

describe('audio retention', () => {
  it('detaches the recording once the words are safely in the transcript', () => {
    const id = recorder.beginNarration('seg-001.wav')
    recorder.completeNarration(id, 'click create agent', { engine: 'whisper:base.en' })

    expect(steps()[0].audio?.file).toBe('seg-001.wav')

    const file = recorder.takeAudio(id)

    expect(file).toBe('seg-001.wav')
    expect(steps()[0].audio).toBeUndefined()
    expect(steps()[0].narration).toBe('click create agent')
  })

  it('returns null for a step that has no recording to detach', () => {
    recorder.addNarration('typed by hand')
    expect(recorder.takeAudio(steps()[0].id)).toBeNull()
  })

  it('leaves the recording in place when transcription failed', () => {
    const id = recorder.beginNarration('seg-001.wav')
    recorder.failNarration(id)

    // This is the case where deleting the audio would lose the take entirely.
    expect(steps()[0].audio?.file).toBe('seg-001.wav')
    expect(steps()[0].narration).toBe('')
  })
})

describe('scratch that', () => {
  it('removes the last step and deletes its media and audio files', async () => {
    const media = join(project.path, MEDIA_DIR, 'a.png')
    const audio = join(project.path, AUDIO_DIR, 'a.wav')
    await mkdir(join(project.path, MEDIA_DIR), { recursive: true })
    await mkdir(join(project.path, AUDIO_DIR), { recursive: true })
    await writeFile(media, 'x')
    await writeFile(audio, 'x')

    const id = recorder.beginNarration('a.wav')
    recorder.completeNarration(id, 'oops')
    recorder.attachImage(img('a.png'))

    expect(steps()).toHaveLength(1)
    await recorder.scratch()

    expect(steps()).toHaveLength(0)
    expect(await pathExists(media)).toBe(false)
    expect(await pathExists(audio)).toBe(false)
  })

  it('is a no-op when there is nothing to drop', async () => {
    expect(await recorder.scratch()).toBeNull()
  })
})

describe('async transcription', () => {
  it('shows a placeholder step immediately and fills it in when whisper finishes', () => {
    const id = recorder.beginNarration('seg-001.wav')

    expect(steps()).toHaveLength(1)
    expect(steps()[0].transcribing).toBe(true)
    expect(steps()[0].narration).toBe('')

    recorder.completeNarration(id, '  click create agent  ', {
      engine: 'whisper:base.en',
      durationMs: 3200
    })

    expect(steps()[0].transcribing).toBe(false)
    expect(steps()[0].narration).toBe('click create agent')
    expect(steps()[0].engine).toBe('whisper:base.en')
    expect(steps()[0].audio).toEqual({ file: 'seg-001.wav', durationMs: 3200 })
  })

  it('clears the transcribing flag when whisper fails', () => {
    const id = recorder.beginNarration('seg-001.wav')
    recorder.failNarration(id)

    expect(steps()[0].transcribing).toBe(false)
  })
})


