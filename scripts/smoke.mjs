#!/usr/bin/env node
/**
 * Runs the app's headless self-test.
 *
 * Unit tests cover the pure logic, but they cannot catch a broken preload path,
 * a white-screening renderer, or resources that vanish once the app is packaged.
 * This boots the real Electron app, drives the real IPC surface, and exits
 * non-zero if anything is wrong.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const require = createRequire(import.meta.url)

if (!existsSync(join(root, 'out', 'main', 'index.js'))) {
  console.error('No build found. Run "npm run build" first.')
  process.exit(1)
}

let electron
try {
  electron = require('electron')
} catch {
  console.error('Electron is not installed. Run "npm install".')
  process.exit(1)
}

const child = spawn(electron, [root], {
  stdio: 'inherit',
  env: {
    ...process.env,
    WC_SELFTEST: '1',
    WC_SELFTEST_OUT: join(root, 'selftest.txt'),
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
  }
})

const timeoutMs = process.env.WC_SELFTEST_COPILOT_CHAT === '1' ? 210_000 : 90_000
const timeout = setTimeout(() => {
  console.error(`\nSelf-test timed out after ${timeoutMs / 1000}s.`)
  child.kill()
  process.exit(1)
}, timeoutMs)

child.on('exit', (code) => {
  clearTimeout(timeout)
  process.exit(code ?? 1)
})
