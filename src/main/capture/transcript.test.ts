import { describe, expect, it } from 'vitest'
import { cleanTranscript, stripFillers } from './transcript'

describe('cleanTranscript', () => {
  it('drops whisper.cpp non-speech markers', () => {
    expect(cleanTranscript('[BLANK_AUDIO] click create agent [SOUND]')).toBe('click create agent')
  })

  it('collapses the whitespace whisper pads its output with', () => {
    expect(cleanTranscript('\n\n  open   the  portal \n')).toBe('open the portal')
  })

  it("drops the marker whisper emits for the app's own alert tone", () => {
    // The beep plays through the speakers while the microphone is still live,
    // so it is recorded; whisper reports it as a non-speech marker.
    expect(cleanTranscript('so we click create [BEEP] and then we wait')).toBe(
      'so we click create and then we wait'
    )
  })

  it('leaves genuine talk about minutes alone', () => {
    const raw = 'this deployment takes about ten minutes so be patient'
    expect(cleanTranscript(raw)).toBe(raw)
  })
})

describe('stripFillers', () => {
  it('removes hesitation words', () => {
    expect(stripFillers('um so we uh click the button')).toBe('so we click the button')
  })

  it('tidies the spacing it leaves behind', () => {
    expect(stripFillers('basically, click it')).toBe('click it')
  })
})

describe('stripFillers', () => {
  it('removes hesitation words', () => {
    expect(stripFillers('um so we uh click the button')).toBe('so we click the button')
  })

  it('tidies the spacing it leaves behind', () => {
    expect(stripFillers('basically, click it')).toBe('click it')
  })
})
