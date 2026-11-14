#!/usr/bin/env node
/**
 * Generates build/icon.ico (and a PNG for other platforms) from an inline SVG.
 *
 * Kept as a script rather than a committed binary so the mark can be tweaked in
 * one place. An .ico is just a small header followed by embedded PNGs, so no
 * icon-specific dependency is needed - sharp rasterises, and we pack the
 * container by hand.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BUILD_DIR = resolve(__dirname, '..', 'build')

/** A capture frame with a mic inside: what the app does, in one mark. */
const SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#2b3550"/>
      <stop offset="100%" stop-color="#141821"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#7fa6ff"/>
      <stop offset="100%" stop-color="#4d7df0"/>
    </linearGradient>
  </defs>

  <rect width="512" height="512" rx="112" fill="url(#bg)"/>

  <!-- crop marks: the snip -->
  <g stroke="url(#accent)" stroke-width="26" stroke-linecap="round" fill="none">
    <path d="M136 168V136h32"/>
    <path d="M344 136h32v32"/>
    <path d="M136 344v32h32"/>
    <path d="M376 344v32h-32"/>
  </g>

  <!-- microphone: the narration -->
  <g fill="#eaf0ff">
    <rect x="228" y="180" width="56" height="104" rx="28"/>
    <path d="M196 268a60 60 0 0 0 120 0" fill="none" stroke="#eaf0ff" stroke-width="22"
          stroke-linecap="round"/>
    <rect x="246" y="330" width="20" height="34" rx="10"/>
  </g>
</svg>
`

/** Pack PNG buffers into an ICO container. */
function buildIco(images) {
  const count = images.length
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(count, 4)

  const directory = Buffer.alloc(16 * count)
  let offset = 6 + 16 * count

  images.forEach((image, i) => {
    const entry = directory.subarray(i * 16)
    // 256 is encoded as 0 in the ICO directory.
    entry.writeUInt8(image.size >= 256 ? 0 : image.size, 0)
    entry.writeUInt8(image.size >= 256 ? 0 : image.size, 1)
    entry.writeUInt8(0, 2) // palette
    entry.writeUInt8(0, 3) // reserved
    entry.writeUInt16LE(1, 4) // colour planes
    entry.writeUInt16LE(32, 6) // bits per pixel
    entry.writeUInt32LE(image.data.length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += image.data.length
  })

  return Buffer.concat([header, directory, ...images.map((i) => i.data)])
}

async function main() {
  await mkdir(BUILD_DIR, { recursive: true })

  const svg = Buffer.from(SVG)
  const sizes = [16, 24, 32, 48, 64, 128, 256]

  const images = []
  for (const size of sizes) {
    const data = await sharp(svg).resize(size, size).png({ compressionLevel: 9 }).toBuffer()
    images.push({ size, data })
  }

  await writeFile(join(BUILD_DIR, 'icon.ico'), buildIco(images))

  // macOS and Linux take a plain PNG.
  await sharp(svg).resize(512, 512).png().toFile(join(BUILD_DIR, 'icon.png'))

  console.log(`OK  Wrote build/icon.ico (${sizes.join(', ')}px) and build/icon.png`)
}

main().catch((err) => {
  console.error(`Failed: ${err.message}`)
  process.exit(1)
})
