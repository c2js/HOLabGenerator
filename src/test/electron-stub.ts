/**
 * Minimal Electron stand-in for tests.
 *
 * The build and prompt modules only need `app` for path lookups, so stubbing it
 * lets the whole guide.md -> AI -> HTML pipeline be tested headlessly instead of
 * only through a running window.
 */
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'

export const app = {
  getAppPath: () => resolve('.'),
  getPath: (name: string) => (name === 'userData' ? resolve(tmpdir(), 'wc-test-userdata') : tmpdir()),
  getName: () => 'workshop-capture'
}

/** A controllable fake clipboard, so the snip pipeline can be tested headlessly. */
let clipboardImage: { png: Buffer; width: number; height: number } | null = null
let clipboardText = ''

export function __setClipboardImage(
  image: { png: Buffer; width: number; height: number } | null
): void {
  clipboardImage = image
}

export function __setClipboardText(text: string): void {
  clipboardText = text
}

export const clipboard = {
  readText: () => clipboardText,
  writeText: (text: string) => {
    clipboardText = text
  },
  readImage: () => ({
    isEmpty: () => clipboardImage === null,
    getSize: () => ({
      width: clipboardImage?.width ?? 0,
      height: clipboardImage?.height ?? 0
    }),
    toPNG: () => clipboardImage?.png ?? Buffer.alloc(0)
  })
}

export const shell = {
  openExternal: async () => undefined,
  openPath: async () => '',
  showItemInFolder: () => undefined
}

export const nativeImage = {
  createFromPath: () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }) })
}

export const screen = {
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
}

export const ipcMain = {
  on: () => undefined,
  once: () => undefined,
  handle: () => undefined
}

export const globalShortcut = {
  register: () => true,
  unregister: () => undefined
}

export default { app, clipboard, shell, nativeImage, screen, ipcMain, globalShortcut }
