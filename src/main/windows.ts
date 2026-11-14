import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BrowserWindow, screen, shell } from 'electron'

const __dirname = dirname(fileURLToPath(import.meta.url))

const isDev = !!process.env['ELECTRON_RENDERER_URL']

export const CONTROL_BAR_WIDTH = 520
export const CONTROL_BAR_HEIGHT = 116

function rendererUrl(page: 'index' | 'hud' | 'audio'): string {
  if (isDev) return `${process.env['ELECTRON_RENDERER_URL']}/${page}.html`
  return pathToFileURL(join(__dirname, `../renderer/${page}.html`)).toString()
}

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 940,
    minHeight: 620,
    show: false,
    backgroundColor: '#0f1115',
    title: 'Workshop Capture',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.once('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  void win.loadURL(rendererUrl('index'))
  return win
}

/**
 * The floating control bar.
 *
 * The main window covers most of the screen, which is exactly what the author
 * cannot afford while demonstrating something. This is the small always-on-top
 * surface that stays out of the way: recorder state, the last thing captured,
 * and the handful of buttons worth clicking.
 *
 * `focusable: false` is the important part. The window still receives mouse
 * clicks, but it never activates - so pressing Snip does not pull focus away
 * from the app being demonstrated, which would change what gets captured.
 */
export function createControlBar(): BrowserWindow {
  const win = new BrowserWindow({
    width: CONTROL_BAR_WIDTH,
    height: CONTROL_BAR_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    acceptFirstMouse: true,
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // 'screen-saver' keeps it above full-screen apps, which is where authors work.
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  void win.loadURL(rendererUrl('hud'))
  return win
}

/** Park the control bar near the bottom centre of the display holding the cursor. */
export function defaultControlBarPosition(): { x: number; y: number } {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const { x, y, width, height } = display.workArea
  return {
    x: Math.round(x + (width - CONTROL_BAR_WIDTH) / 2),
    y: Math.round(y + height - CONTROL_BAR_HEIGHT - 40)
  }
}

/** Place the control bar, keeping it on a display that actually exists. */
export function placeControlBar(win: BrowserWindow, saved?: { x: number; y: number }): void {
  const target = saved ?? defaultControlBarPosition()
  const displays = screen.getAllDisplays()

  const visible = displays.some((d) => {
    const a = d.workArea
    return (
      target.x + CONTROL_BAR_WIDTH > a.x &&
      target.x < a.x + a.width &&
      target.y + CONTROL_BAR_HEIGHT > a.y &&
      target.y < a.y + a.height
    )
  })

  // A monitor that has since been unplugged would otherwise strand the bar
  // off-screen with no way to get it back.
  const position = visible ? target : defaultControlBarPosition()
  win.setPosition(position.x, position.y)
}
