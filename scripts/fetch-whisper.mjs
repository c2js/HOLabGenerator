#!/usr/bin/env node
/**
 * Fetches the whisper.cpp model and CLI binary into resources/whisper/ so the
 * app has working local speech-to-text.
 *
 * The model is downloaded rather than committed: it is well over 100 MB, which
 * has no business being in a git repository.
 *
 *   npm run fetch:whisper                       # model + engine (what you want)
 *   node scripts/fetch-whisper.mjs --model tiny.en
 *   node scripts/fetch-whisper.mjs --model-only # skip the engine
 *
 * Both parts are fetched by default. Downloading the model but not the engine
 * only ever produces an app that records audio it cannot transcribe, and making
 * the engine opt-in meant the flag could be swallowed by `npm run ... -- --x`.
 */
import { createWriteStream } from 'node:fs'
import { mkdir, stat, rename, rm, readdir, copyFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TARGET_DIR = resolve(__dirname, '..', 'resources', 'whisper')

const MODELS = {
  'tiny.en': { file: 'ggml-tiny.en.bin', approxMb: 75 },
  'base.en': { file: 'ggml-base.en.bin', approxMb: 142 },
  'small.en': { file: 'ggml-small.en.bin', approxMb: 466 }
}

const MODEL_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'
const RELEASES_API = 'https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback
}

const flag = (name) => process.argv.includes(`--${name}`)

async function exists(p) {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

function bar(received, total) {
  if (!total) return `${(received / 1024 / 1024).toFixed(1)} MB`
  const pct = received / total
  const width = 28
  const filled = Math.round(pct * width)
  return `[${'#'.repeat(filled)}${'-'.repeat(width - filled)}] ${(pct * 100).toFixed(0)}%  ${(
    received /
    1024 /
    1024
  ).toFixed(1)} MB`
}

async function download(url, destination, label) {
  const tmp = `${destination}.part`
  await rm(tmp, { force: true })

  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`${label}: HTTP ${response.status} ${response.statusText}`)
  }

  const total = Number(response.headers.get('content-length') ?? 0)
  let received = 0
  let lastPaint = 0

  const source = Readable.fromWeb(response.body)
  source.on('data', (chunk) => {
    received += chunk.length
    const now = Date.now()
    if (now - lastPaint > 120) {
      lastPaint = now
      process.stdout.write(`\r  ${label} ${bar(received, total)}   `)
    }
  })

  await pipeline(source, createWriteStream(tmp))
  await rename(tmp, destination)
  process.stdout.write(`\r  ${label} ${bar(received, total || received)}   \n`)
}

async function fetchModel() {
  const key = arg('model', 'base.en')
  const model = MODELS[key]
  if (!model) {
    console.error(`Unknown model "${key}". Choose one of: ${Object.keys(MODELS).join(', ')}`)
    process.exit(1)
  }

  const destination = join(TARGET_DIR, model.file)
  if (await exists(destination)) {
    console.log(`OK  Model already present: ${model.file}`)
    return
  }

  console.log(`--> Downloading ${model.file} (~${model.approxMb} MB)`)
  await download(`${MODEL_BASE}/${model.file}`, destination, model.file)
  console.log(`OK  Model ready: ${destination}`)
}

async function fetchBinary() {
  if (process.platform !== 'win32') {
    console.log(
      '\nBinary auto-download is only wired up for Windows.\n' +
        'On macOS: brew install whisper-cpp, then copy or symlink the `whisper-cli`\n' +
        `binary into ${TARGET_DIR}`
    )
    return
  }

  const existing = await readdir(TARGET_DIR).catch(() => [])
  if (existing.some((f) => /^(whisper-cli|main|whisper)\.exe$/i.test(f))) {
    console.log('OK  whisper.cpp binary already present')
    return
  }

  console.log('--> Looking for a Windows build in the latest whisper.cpp release')

  const response = await fetch(RELEASES_API, {
    headers: { 'user-agent': 'hands-on-lab-generator-setup', accept: 'application/vnd.github+json' }
  })

  if (!response.ok) {
    printManualBinaryHelp(`GitHub API returned HTTP ${response.status}`)
    return
  }

  const release = await response.json()
  const asset = (release.assets ?? []).find((a) => /bin-x64\.zip$/i.test(a.name))

  if (!asset) {
    printManualBinaryHelp(`No x64 Windows asset in release ${release.tag_name ?? 'unknown'}`)
    return
  }

  const zipPath = join(TARGET_DIR, asset.name)
  if (!(await exists(zipPath))) {
    await download(asset.browser_download_url, zipPath, asset.name)
  } else {
    console.log(`OK  Archive already downloaded: ${asset.name}`)
  }

  await extractBinary(zipPath)
}

/**
 * whisper.cpp ships its Windows build as a zip with everything under Release/,
 * including demos and test executables we have no use for. Flatten out just the
 * CLI and the libraries it loads, then throw the archive away - leaving the user
 * to run Expand-Archive by hand was the whole bug this replaces.
 *
 * Expand-Archive is used rather than an unzip dependency because it already
 * ships with Windows, which is the same principle the rest of the app follows.
 */
async function extractBinary(zipPath) {
  const staging = join(TARGET_DIR, '_extract')
  await rm(staging, { recursive: true, force: true })

  console.log('--> Extracting')
  await runPowerShell(
    `Expand-Archive -LiteralPath ${psQuote(zipPath)} -DestinationPath ${psQuote(staging)} -Force`
  )

  const wanted = (name) =>
    /^whisper-cli\.exe$/i.test(name) ||
    /^whisper\.dll$/i.test(name) ||
    /^ggml.*\.dll$/i.test(name)

  const copied = []
  for (const file of await walk(staging)) {
    const name = file.split(/[\\/]/).pop()
    if (!wanted(name)) continue
    await copyFile(file, join(TARGET_DIR, name))
    copied.push(name)
  }

  await rm(staging, { recursive: true, force: true })

  if (!copied.some((f) => /^whisper-cli\.exe$/i.test(f))) {
    printManualBinaryHelp('whisper-cli.exe was not present in the archive')
    return
  }

  await rm(zipPath, { force: true })
  console.log(`OK  Installed whisper-cli.exe and ${copied.length - 1} support libraries`)
}

async function walk(dir) {
  const out = []
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(full)))
    else out.push(full)
  }
  return out
}

function psQuote(value) {
  return `'${value.replace(/'/g, "''")}'`
}

function runPowerShell(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }
    )
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(stderr.trim() || `PowerShell exited ${code}`))
    )
  })
}

function printManualBinaryHelp(reason) {
  console.log(
    `\n!   Could not fetch the binary automatically (${reason}).\n\n` +
      '    The app still works without it: dictation records the audio and creates\n' +
      '    the step, you just type the narration instead of it being transcribed.\n\n' +
      '    To enable transcription, get a whisper.cpp build for your platform from\n' +
      '    https://github.com/ggml-org/whisper.cpp/releases and put whisper-cli\n' +
      `    (with any accompanying DLLs) into:\n      ${TARGET_DIR}\n`
  )
}

async function main() {
  await mkdir(TARGET_DIR, { recursive: true })
  await fetchModel()

  if (flag('model-only')) {
    console.log('\nSkipping the engine (--model-only). Dictation will record but not transcribe.')
    return
  }

  await fetchBinary()
  await verify()
}

/** Prove the engine actually runs, rather than just that files landed on disk. */
async function verify() {
  const cli = join(TARGET_DIR, 'whisper-cli.exe')
  if (process.platform !== 'win32' || !(await exists(cli))) return

  const ok = await new Promise((resolve) => {
    const child = spawn(cli, ['--help'], { windowsHide: true, stdio: 'ignore' })
    child.on('error', () => resolve(false))
    // whisper-cli exits non-zero for --help on some builds; running at all is the signal.
    child.on('exit', () => resolve(true))
  })

  console.log(
    ok
      ? '\nOK  Engine responds. Local transcription is ready.'
      : '\n!   whisper-cli.exe is present but would not start. A missing Visual C++ runtime\n' +
          '    is the usual cause: install the Microsoft Visual C++ 2015-2022 Redistributable (x64).'
  )
}

main().catch((err) => {
  console.error(`\nFailed: ${err.message}`)
  process.exit(1)
})
