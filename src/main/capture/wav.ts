/**
 * Minimal RIFF/WAVE writer.
 *
 * whisper.cpp wants 16-bit mono PCM at 16 kHz. We capture at exactly that rate
 * in the audio host window (an AudioContext created with `sampleRate: 16000`
 * makes the browser resample the microphone for us), so all that is left is to
 * bolt a 44-byte header onto the samples. No ffmpeg, no transcoding, no extra
 * binary to ship.
 */
export const WAV_SAMPLE_RATE = 16_000
const BITS_PER_SAMPLE = 16
const CHANNELS = 1

export function encodeWav(pcm: Buffer, sampleRate = WAV_SAMPLE_RATE): Buffer {
  const byteRate = (sampleRate * CHANNELS * BITS_PER_SAMPLE) / 8
  const blockAlign = (CHANNELS * BITS_PER_SAMPLE) / 8
  const header = Buffer.alloc(44)

  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')

  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16) // PCM chunk size
  header.writeUInt16LE(1, 20) // format: PCM
  header.writeUInt16LE(CHANNELS, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(BITS_PER_SAMPLE, 34)

  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)

  return Buffer.concat([header, pcm])
}

/** Duration of a 16-bit mono PCM buffer, in milliseconds. */
export function pcmDurationMs(pcm: Buffer, sampleRate = WAV_SAMPLE_RATE): number {
  return Math.round((pcm.length / 2 / sampleRate) * 1000)
}
