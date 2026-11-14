/**
 * The audio host: a hidden window whose only job is to own the microphone.
 *
 * Everything here exists so the main process never has to deal with audio
 * hardware, and so we never need ffmpeg. The AudioContext is created at
 * 16 kHz, which makes the browser resample the microphone for us, and an
 * AudioWorklet hands us raw Float32 frames. We convert those to 16-bit PCM and
 * ship them to the main process, which only has to add a WAV header.
 */
import type { AudioBridge } from '../../preload/audio'

declare global {
  interface Window {
    audioBridge: AudioBridge
  }
}

const SAMPLE_RATE = 16_000

/** Inlined as a Blob so it works identically from the dev server and from file://. */
const WORKLET_SOURCE = `
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]
    if (input && input[0]) {
      // Copy: the underlying buffer is reused by the audio thread.
      this.port.postMessage(new Float32Array(input[0]))
    }
    return true
  }
}
registerProcessor('capture-processor', CaptureProcessor)
`

let context: AudioContext | null = null
let stream: MediaStream | null = null
let node: AudioWorkletNode | null = null
let source: MediaStreamAudioSourceNode | null = null
let chunks: Float32Array[] = []
let recording = false
let levelTimer: number | null = null
let peak = 0
let activeDeviceId: string | undefined

async function ensureGraph(deviceId?: string): Promise<void> {
  // A device change has to tear the graph down; the stream is bound to the mic
  // it was opened with.
  if (context && stream && node && deviceId === activeDeviceId) return
  teardown()

  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {})
    }
  })
  activeDeviceId = deviceId

  context = new AudioContext({ sampleRate: SAMPLE_RATE })

  const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' })
  const url = URL.createObjectURL(blob)
  try {
    await context.audioWorklet.addModule(url)
  } finally {
    URL.revokeObjectURL(url)
  }

  source = context.createMediaStreamSource(stream)
  node = new AudioWorkletNode(context, 'capture-processor')

  node.port.onmessage = (event: MessageEvent<Float32Array>) => {
    if (!recording) return
    const frame = event.data
    chunks.push(frame)
    for (let i = 0; i < frame.length; i++) {
      const v = Math.abs(frame[i])
      if (v > peak) peak = v
    }
  }

  source.connect(node)
  // Deliberately not connected to the destination: we are listening, not
  // monitoring, and routing mic audio to the speakers would cause feedback.
}

function teardown(): void {
  try {
    source?.disconnect()
    node?.disconnect()
    stream?.getTracks().forEach((t) => t.stop())
    void context?.close()
  } catch {
    /* tearing down a half-built graph is fine */
  }
  source = null
  node = null
  stream = null
  context = null
}

/**
 * A short tone, rather than a spoken warning.
 *
 * The alert plays through the speakers while the microphone is still live, so
 * whatever it is gets recorded. A beep is transcribed as nothing (or a
 * non-speech marker we already strip); spoken words end up as text in the very
 * step being warned about.
 */
function beep(pattern: 'warning' | 'limit'): void {
  try {
    const ctx = new AudioContext()
    const now = ctx.currentTime
    const blips = pattern === 'limit' ? [0, 0.18, 0.36] : [0, 0.18]

    for (const offset of blips) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()

      osc.type = 'sine'
      osc.frequency.value = pattern === 'limit' ? 660 : 880

      // Short, with a soft envelope: a hard square edge clicks and carries much
      // further into the microphone.
      gain.gain.setValueAtTime(0.0001, now + offset)
      gain.gain.exponentialRampToValueAtTime(0.18, now + offset + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.12)

      osc.connect(gain).connect(ctx.destination)
      osc.start(now + offset)
      osc.stop(now + offset + 0.14)
    }

    setTimeout(() => void ctx.close(), 1200)
  } catch {
    /* an alert that fails is not worth interrupting a recording for */
  }
}

async function listDevices(): Promise<void> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    window.audioBridge.sendDevices(
      devices
        .filter((d) => d.kind === 'audioinput')
        .map((d, i) => ({
          id: d.deviceId,
          // Labels are blank until microphone permission has been granted once.
          label: d.label || `Microphone ${i + 1}`
        }))
    )
  } catch {
    window.audioBridge.sendDevices([])
  }
}

function toPcm16(frames: Float32Array[]): Uint8Array {
  let total = 0
  for (const f of frames) total += f.length

  const out = new Int16Array(total)
  let offset = 0
  for (const frame of frames) {
    for (let i = 0; i < frame.length; i++) {
      const s = Math.max(-1, Math.min(1, frame[i]))
      out[offset++] = s < 0 ? s * 0x8000 : s * 0x7fff
    }
  }
  return new Uint8Array(out.buffer)
}

async function start(deviceId?: string): Promise<void> {
  if (recording) return
  try {
    await ensureGraph(deviceId)
    if (context?.state === 'suspended') await context.resume()
    chunks = []
    peak = 0
    recording = true

    // Labels only become readable once permission has been granted, so refresh
    // the list the first time the microphone actually opens.
    void listDevices()

    levelTimer = window.setInterval(() => {
      window.audioBridge.sendLevel(peak)
      peak = 0
    }, 150)
  } catch (err) {
    recording = false
    window.audioBridge.sendError(describe(err))
  }
}

function stop(): void {
  if (!recording) return
  recording = false

  if (levelTimer !== null) {
    window.clearInterval(levelTimer)
    levelTimer = null
  }

  const frames = chunks
  chunks = []
  window.audioBridge.sendSegment(toPcm16(frames), SAMPLE_RATE)
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'NotAllowedError') {
      return 'Microphone access was blocked. Allow it in Windows Settings > Privacy > Microphone.'
    }
    if (err.name === 'NotFoundError') return 'No microphone was found.'
    if (err.name === 'OverconstrainedError') {
      return 'The selected microphone is no longer available. Choose another one.'
    }
    return err.message
  }
  return String(err)
}

window.audioBridge.onStart((deviceId) => void start(deviceId))
window.audioBridge.onStop(() => stop())
window.audioBridge.onBeep((pattern) => beep(pattern))
window.audioBridge.onEnumerate(() => void listDevices())
window.audioBridge.ready()
void listDevices()

export {}
