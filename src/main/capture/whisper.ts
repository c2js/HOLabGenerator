import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import { cpus } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app } from 'electron'
import { cleanTranscript } from './transcript'

const __dirname = dirname(fileURLToPath(import.meta.url))

export interface WhisperConfig {
  /** Absolute path to the whisper.cpp CLI, or null to auto-detect. */
  binaryPath?: string | null
  /** Absolute path to a ggml model file, or null to auto-detect. */
  modelPath?: string | null
  /** Terms fed to the model as an initial prompt to sharpen jargon accuracy. */
  vocabulary?: string[]
  threads?: number
}

export interface TranscriptionResult {
  text: string
  engine: string
}

export type WhisperAvailability =
  | { ok: true; binaryPath: string; modelPath: string; modelName: string }
  | { ok: false; reason: string }

/** Names whisper.cpp has shipped its CLI under across releases. */
const BINARY_NAMES =
  process.platform === 'win32'
    ? ['whisper-cli.exe', 'main.exe', 'whisper.exe']
    : ['whisper-cli', 'main', 'whisper']

const MODEL_PREFERENCE = [
  'ggml-base.en.bin',
  'ggml-small.en.bin',
  'ggml-tiny.en.bin',
  'ggml-base.bin',
  'ggml-small.bin',
  'ggml-tiny.bin'
]

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/**
 * Local speech-to-text via a whisper.cpp sidecar.
 *
 * The engine is optional at runtime on purpose. If the binary or model is
 * missing, dictation still records and still creates the step - the author just
 * types the narration instead. Losing transcription must never mean losing the
 * take.
 */
export class WhisperEngine {
  private resolved: WhisperAvailability | null = null

  constructor(private config: WhisperConfig = {}) {}

  configure(config: WhisperConfig): void {
    this.config = { ...this.config, ...config }
    // Only a path change invalidates detection; vocabulary is per-run.
    if ('binaryPath' in config || 'modelPath' in config) this.resolved = null
  }

  /** Directories searched for the binary and model, in priority order. */
  searchDirs(): string[] {
    const dirs = [join(app.getPath('userData'), 'whisper')]
    if (process.resourcesPath) dirs.push(join(process.resourcesPath, 'whisper'))
    dirs.push(join(__dirname, '../../resources/whisper'))
    dirs.push(join(app.getAppPath(), 'resources', 'whisper'))
    return dirs
  }

  async availability(): Promise<WhisperAvailability> {
    if (this.resolved) return this.resolved

    const dirs = this.searchDirs()

    let binaryPath = this.config.binaryPath ?? null
    if (binaryPath && !(await exists(binaryPath))) binaryPath = null
    if (!binaryPath) {
      outer: for (const dir of dirs) {
        for (const name of BINARY_NAMES) {
          const candidate = join(dir, name)
          if (await exists(candidate)) {
            binaryPath = candidate
            break outer
          }
        }
      }
    }

    if (!binaryPath) {
      this.resolved = {
        ok: false,
        reason: `No whisper.cpp binary found. Put whisper-cli${process.platform === 'win32' ? '.exe' : ''} in ${dirs[0]} (see npm run fetch:whisper).`
      }
      return this.resolved
    }

    let modelPath = this.config.modelPath ?? null
    if (modelPath && !(await exists(modelPath))) modelPath = null
    if (!modelPath) {
      outer: for (const dir of dirs) {
        for (const name of MODEL_PREFERENCE) {
          const candidate = join(dir, name)
          if (await exists(candidate)) {
            modelPath = candidate
            break outer
          }
        }
      }
    }

    if (!modelPath) {
      this.resolved = {
        ok: false,
        reason: `No Whisper model found. Run "npm run fetch:whisper" to download ggml-base.en.bin into ${dirs[0]}.`
      }
      return this.resolved
    }

    this.resolved = {
      ok: true,
      binaryPath,
      modelPath,
      modelName: basename(modelPath).replace(/^ggml-|\.bin$/g, '')
    }
    return this.resolved
  }

  /**
   * Transcribe one dictation segment.
   *
   * Segments are short (the span between two hotkey presses), so this is a
   * quick batch job rather than a streaming pipeline - which is why we never
   * needed word-level timestamps or a streaming engine in the first place.
   */
  async transcribe(wavPath: string): Promise<TranscriptionResult> {
    const avail = await this.availability()
    if (!avail.ok) throw new Error(avail.reason)

    const args = [
      '-m', avail.modelPath,
      '-f', wavPath,
      '--output-txt',
      '--output-file', wavPath.replace(/\.wav$/i, ''),
      '--no-timestamps',
      '--language', 'en',
      '--threads', String(this.config.threads ?? Math.max(2, Math.min(8, cpuCount() - 1)))
    ]

    const vocab = (this.config.vocabulary ?? []).filter(Boolean)
    if (vocab.length) {
      // whisper.cpp biases decoding toward terms in the initial prompt, which
      // is what rescues words like "Entra", "Bicep" and "Kusto".
      args.push('--prompt', vocab.join(', '))
    }

    await new Promise<void>((resolve, reject) => {
      execFile(
        avail.binaryPath,
        args,
        { timeout: 5 * 60_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
        (err) => (err ? reject(err) : resolve())
      )
    })

    const txtPath = wavPath.replace(/\.wav$/i, '.txt')
    let text = ''
    try {
      text = await fs.readFile(txtPath, 'utf8')
    } finally {
      await fs.rm(txtPath, { force: true }).catch(() => undefined)
    }

    return { text: cleanTranscript(text), engine: `whisper:${avail.modelName}` }
  }
}

function cpuCount(): number {
  try {
    return cpus().length
  } catch {
    return 4
  }
}
