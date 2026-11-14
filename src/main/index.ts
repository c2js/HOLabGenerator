import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promises as fs } from 'node:fs'
import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron'
import { CH, type NewProjectRequest, type ToastMessage } from '@shared/ipc'
import type { CopilotSendRequest } from '@shared/copilot'
import type { LoadedProject, ProjectMeta, Step } from '@shared/types'
import { renumberImageTokens } from '@shared/types'
import { disposePlatform, platform } from './platform'
import {
  createProject,
  EXPORT_DIR,
  MEDIA_DIR,
  mediaPath,
  openProject,
  pathExists,
  ProjectStore,
  PROJECT_FILE
} from './project/store'
import { Recorder } from './capture/recorder'
import { CaptureController } from './capture/controller'
import { WhisperEngine } from './capture/whisper'
import { BINDINGS, registerHotkeys, type HotkeyRegistration } from './capture/hotkeys'
import { verifyWebGuide } from './build/verifyWeb'
import { CopilotConversation } from './build/copilot'
import { createMainWindow, createControlBar, placeControlBar } from './windows'
import { SettingsStore } from './settings'

const MEDIA_SCHEME = 'wcmedia'

// Must run before the app is ready.
protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])

const store = new ProjectStore()
const recorder = new Recorder(store)
const whisper = new WhisperEngine()
const settings = new SettingsStore()
const copilot = new CopilotConversation((state) => broadcast(CH.onCopilotChanged, state))

let controller: CaptureController | null = null
let hotkeys: HotkeyRegistration | null = null
let mainWindow: BrowserWindow | null = null
let controlBar: BrowserWindow | null = null
/** True only while compact mode is the reason the main window is hidden. */
let hiddenByCompact = false
/** True while the control bar is hidden so it cannot appear in a snip. */
let barHiddenForSnip = false

// ---------------------------------------------------------------------------
// Broadcasting
// ---------------------------------------------------------------------------

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

function toast(kind: ToastMessage['kind'], text: string): void {
  broadcast(CH.onToast, { kind, text } satisfies ToastMessage)
}

store.on('changed', (project: LoadedProject | null) => {
  broadcast(CH.onProjectChanged, project)
  syncWindows()
})
store.on('save-error', (err: unknown) => {
  toast('error', `Could not save the project: ${errorText(err)}`)
})
recorder.on('status', (status) => {
  broadcast(CH.onRecorderStatus, status)

  // The bar is always-on-top, so during a snip it would sit in front of the very
  // thing being captured. Get it out of the way entirely, then bring it back.
  if (controlBar && !controlBar.isDestroyed()) {
    const shouldHide = status.state === 'capturing'
    if (shouldHide && controlBar.isVisible()) {
      controlBar.hide()
      barHiddenForSnip = true
    } else if (!shouldHide && barHiddenForSnip) {
      barHiddenForSnip = false
      syncWindows()
    }
  }
})

settings.on('changed', () => {
  broadcast(CH.onSettingsChanged, publicSettings())
  syncWindows()
})

function publicSettings(): {
  projectsDir: string
  showMiniBar: boolean
  compact: boolean
  compactOnCreate: boolean
  micDeviceId: string
} {
  const { projectsDir, showMiniBar, compact, compactOnCreate, micDeviceId } = settings.current
  return { projectsDir, showMiniBar, compact, compactOnCreate, micDeviceId }
}

/**
 * Reconcile window visibility with the current mode.
 *
 * The control bar earns its place only while there is something to capture
 * into, so it follows the open project. Compact mode additionally gets the big
 * window out of the way entirely, which is the point of it.
 *
 * Crucially this only ever re-shows a window *we* hid. Calling show() on any
 * invisible window would fight the user every time they minimised it, since a
 * minimised window also reports itself as not visible.
 */
function syncWindows(): void {
  const { showMiniBar, compact } = settings.current
  const hasProject = !!store.current

  if (controlBar && !controlBar.isDestroyed()) {
    const shouldShow = hasProject && (showMiniBar || compact) && !barHiddenForSnip
    if (shouldShow && !controlBar.isVisible()) controlBar.showInactive()
    else if (!shouldShow && controlBar.isVisible()) controlBar.hide()
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    // Never hide the main window when there is no project open, or the app
    // would vanish with no way back to it.
    if (compact && hasProject) {
      if (mainWindow.isVisible()) {
        hiddenByCompact = true
        mainWindow.hide()
      }
    } else if (hiddenByCompact) {
      hiddenByCompact = false
      mainWindow.show()
    }
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---------------------------------------------------------------------------
// Media protocol: wcmedia://media/<file>
// ---------------------------------------------------------------------------

function registerMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const project = store.current
    if (!project) return new Response('No project open', { status: 404 })

    const url = new URL(request.url)
    const file = decodeURIComponent(url.pathname).replace(/^\/+/, '')

    // Contain reads to the project's media folder.
    if (!file || file.includes('..')) return new Response('Bad request', { status: 400 })

    const abs = join(project.path, MEDIA_DIR, file)
    if (!abs.startsWith(join(project.path, MEDIA_DIR))) {
      return new Response('Forbidden', { status: 403 })
    }
    if (!(await pathExists(abs))) return new Response('Not found', { status: 404 })

    return net.fetch(pathToFileURL(abs).toString())
  })
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function defaultProjectsDir(): string {
  return settings.current.projectsDir
}

function registerIpc(): void {
  ipcMain.handle(CH.projectNew, async (_e, req: NewProjectRequest) => {
    await store.flush()
    await copilot.close()
    const parent = req.parentDir ?? (await settings.ensureProjectsDir())
    await fs.mkdir(parent, { recursive: true })
    const project = await createProject(parent, req.title, req.author)
    store.set(project)
    controller?.onProjectChanged()
    toast('success', `Created ${project.meta.title}`)

    // Straight into authoring: the big window is only in the way once there is
    // something to capture into.
    if (settings.current.compactOnCreate) settings.update({ compact: true })
    return project
  })

  ipcMain.handle(CH.projectOpen, async () => {
    const parent = defaultProjectsDir()
    await fs.mkdir(parent, { recursive: true })

    const result = await dialog.showOpenDialog({
      title: 'Open a guide project',
      defaultPath: parent,
      properties: ['openDirectory'],
      buttonLabel: 'Open guide'
    })
    if (result.canceled || !result.filePaths[0]) return null

    const dir = result.filePaths[0]
    if (!(await pathExists(join(dir, PROJECT_FILE)))) {
      toast('error', 'That folder is not a guide project (no project.json inside).')
      return null
    }

    try {
      await store.flush()
      await copilot.close()
      const project = await openProject(dir)
      store.set(project)
      controller?.onProjectChanged()
      return project
    } catch (err) {
      toast('error', errorText(err))
      return null
    }
  })

  ipcMain.handle(CH.projectCurrent, () => store.current)

  ipcMain.handle(CH.projectSaveSteps, (_e, steps: Step[]) => {
    // Tokens must always match document order or the AI round trip breaks.
    return store.setSteps(renumberImageTokens(steps))
  })

  ipcMain.handle(CH.projectSaveMeta, (_e, meta: Partial<ProjectMeta>) =>
    store.update((p) => ({ ...p, meta: { ...p.meta, ...meta } }))
  )

  ipcMain.handle(CH.projectReveal, async () => {
    const project = store.current
    if (project) shell.showItemInFolder(join(project.path, PROJECT_FILE))
  })

  ipcMain.handle(CH.projectClose, async () => {
    await copilot.close()
    await store.flush()
    store.set(null)
    controller?.onProjectChanged()
  })

  ipcMain.handle(CH.recorderStatus, () => recorder.status)

  ipcMain.handle(CH.recorderAddManualStep, (_e, narration: string) => {
    if (!store.current) {
      toast('warning', 'Create or open a guide project first.')
      return
    }
    recorder.addNarration(narration, 'manual')
  })

  ipcMain.handle(CH.recorderToggleDictation, () => controller?.toggleDictation())
  ipcMain.handle(CH.recorderSnip, (_e, stepId?: string) => controller?.snip(stepId))
  ipcMain.handle(CH.recorderBreak, () => controller?.sectionBreak())
  ipcMain.handle(CH.recorderScratch, () => controller?.scratch())
  ipcMain.handle(CH.recorderClipboard, () => controller?.clipboardCode())
  ipcMain.handle(CH.recorderRemoveImage, async (_e, imageId: string) => {
    const project = store.current
    if (!project) return false
    const file = recorder.removeImage(imageId)
    if (!file) return false
    await fs.rm(mediaPath(project, file), { force: true }).catch(() => undefined)
    return true
  })

  ipcMain.handle(CH.mediaUrl, (_e, file: string) => {
    if (!store.current || !file) return null
    return `${MEDIA_SCHEME}://media/${encodeURIComponent(file)}`
  })

  // -------------------------------------------------- in-app SDK conversation

  function chatProject(projectPath: string): LoadedProject {
    const project = store.current
    if (!project || project.path !== projectPath) throw new Error('The open project changed.')
    return project
  }

  ipcMain.handle(CH.copilotState, () => store.current ? copilot.open(store.current) : null)
  ipcMain.handle(CH.copilotStatus, () => copilot.status())
  ipcMain.handle(CH.copilotSend, async (_e, request: CopilotSendRequest) => {
    const project = chatProject(request.projectPath)
    store.scheduleSave()
    await store.flush()
    chatProject(request.projectPath)
    await copilot.send(project, request)
  })
  ipcMain.handle(CH.copilotStop, (_e, projectPath: string) => {
    chatProject(projectPath)
    return copilot.stop(projectPath)
  })
  ipcMain.handle(CH.copilotReset, (_e, projectPath: string) =>
    copilot.reset(chatProject(projectPath))
  )
  ipcMain.handle(CH.copilotPermission, (_e, projectPath: string, id: string, approve: boolean) => {
    chatProject(projectPath)
    copilot.permission(projectPath, id, approve === true)
  })
  ipcMain.handle(CH.copilotAnswer, (_e, projectPath: string, id: string, answer: string) => {
    chatProject(projectPath)
    copilot.answer(projectPath, id, answer)
  })

  ipcMain.handle(CH.buildVerifyWeb, async () => {
    const project = store.current
    if (!project) {
      return {
        ok: false,
        exists: false,
        bytes: 0,
        issues: [{ severity: 'error' as const, message: 'No project is open.' }],
        referenced: [],
        missing: [],
        unreferenced: [],
        unused: []
      }
    }
    await store.flush()
    return verifyWebGuide(project)
  })

  ipcMain.handle(CH.buildOpenWeb, async () => {
    const project = store.current
    if (!project) return
    const file = join(project.path, EXPORT_DIR, 'web', 'guide.html')
    if (await pathExists(file)) await shell.openPath(file)
    else toast('warning', 'The guide has not been generated yet.')
  })

  // ------------------------------------------------------- engine + recovery
  ipcMain.handle(CH.whisperStatus, async () => {
    const available = await whisper.availability()
    return available.ok
      ? {
          ok: true,
          modelName: available.modelName,
          binaryPath: available.binaryPath,
          searchedIn: whisper.searchDirs()
        }
      : { ok: false, reason: available.reason, searchedIn: whisper.searchDirs() }
  })

  ipcMain.handle(CH.recorderRetranscribe, async (_e, stepId?: string) => {
    const result = (await controller?.retranscribe(stepId)) ?? {
      attempted: 0,
      succeeded: 0,
      failed: 0,
      error: 'The recorder is not ready.'
    }

    if (result.error) toast('warning', result.error)
    else if (result.succeeded) {
      toast(
        'success',
        `Re-transcribed ${result.succeeded} step${result.succeeded === 1 ? '' : 's'}` +
          (result.failed ? `, ${result.failed} produced no text.` : '.')
      )
    } else {
      toast('warning', 'Nothing could be transcribed from the saved audio.')
    }
    return result
  })

  // ---------------------------------------------------------------- settings

  ipcMain.handle(CH.settingsGet, () => publicSettings())

  ipcMain.handle(CH.settingsSet, (_e, patch: Partial<ReturnType<typeof publicSettings>>) => {
    settings.update(patch)
    if (patch.micDeviceId !== undefined) controller?.setInputDevice(patch.micDeviceId || undefined)
    return publicSettings()
  })

  ipcMain.handle(CH.audioDeviceList, () => {
    controller?.refreshInputDevices()
    return controller?.inputDevices() ?? []
  })

  ipcMain.handle(CH.audioDeviceSet, (_e, deviceId: string) => {
    settings.update({ micDeviceId: deviceId })
    controller?.setInputDevice(deviceId || undefined)
  })

  ipcMain.handle(CH.settingsChooseProjectsDir, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Where should new guides be created?',
      defaultPath: settings.current.projectsDir,
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Use this folder'
    })
    if (result.canceled || !result.filePaths[0]) return null

    settings.update({ projectsDir: result.filePaths[0] })
    await settings.ensureProjectsDir()
    toast('success', 'New guides will be created here from now on.')
    return publicSettings()
  })

  ipcMain.handle(CH.settingsOpenProjectsDir, async () => {
    const dir = await settings.ensureProjectsDir()
    await shell.openPath(dir)
  })

  // -------------------------------------------------------------- window mode

  ipcMain.handle(CH.uiSetCompact, (_e, compact: boolean) => {
    settings.update({ compact })
  })

  ipcMain.handle(CH.uiShowMain, () => {
    settings.update({ compact: false })
    if (mainWindow && !mainWindow.isDestroyed()) {
      hiddenByCompact = false
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })

  ipcMain.handle(CH.uiMoveControlBar, (_e, dx: number, dy: number) => {
    if (!controlBar || controlBar.isDestroyed()) return
    const [x, y] = controlBar.getPosition()
    controlBar.setPosition(Math.round(x + dx), Math.round(y + dy))
  })

  ipcMain.handle(CH.uiResizeControlBar, (_e, height: number) => {
    if (!controlBar || controlBar.isDestroyed()) return
    // The renderer measures its own content, so the bar fits at any DPI or
    // font-scaling setting rather than trusting a hard-coded height.
    const target = Math.max(80, Math.min(260, Math.round(height)))
    const [width, current] = controlBar.getSize()
    if (Math.abs(current - target) <= 1) return

    const [x, y] = controlBar.getPosition()
    controlBar.setBounds({ x, y, width, height: target })
  })
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

const isSelfTest = process.env['WC_SELFTEST'] === '1'

if (isSelfTest) {
  // Run against a throwaway profile. The self-test changes real preferences
  // (the projects folder, compact mode), and it has no business overwriting
  // what the person using this machine actually chose.
  app.setPath('userData', join(app.getPath('temp'), `wc-selftest-profile-${process.pid}`))
}

const gotLock = app.requestSingleInstanceLock()

if (!gotLock) {
  // Without this, a stray running instance makes the self-test exit 0 having
  // asserted precisely nothing - a silent pass, which is worse than a failure.
  if (isSelfTest) {
    console.error(
      'Self-test aborted: another Workshop Capture instance already holds the single-instance lock.'
    )
    app.exit(1)
  } else {
    app.quit()
  }
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(async () => {
    await settings.load()
    await settings.ensureProjectsDir()

    registerMediaProtocol()
    registerIpc()

    mainWindow = createMainWindow()
    mainWindow.on('closed', () => {
      mainWindow = null
    })
    // Closing the main window in compact mode would leave only the bar, so
    // treat a close as "I am done", not "hide this".
    mainWindow.on('close', () => {
      if (settings.current.compact) settings.update({ compact: false })
    })

    controlBar = createControlBar()
    controlBar.on('closed', () => {
      controlBar = null
    })
    placeControlBar(controlBar, settings.current.miniBar)
    controlBar.on('moved', () => {
      if (!controlBar || controlBar.isDestroyed()) return
      const [x, y] = controlBar.getPosition()
      settings.update({ miniBar: { x, y } })
    })

    controller = new CaptureController(store, recorder, platform(), whisper, {
      toast: (kind, text) => toast(kind, text)
    })
    await controller.init()
    controller.setInputDevice(settings.current.micDeviceId || undefined)

    hotkeys = registerHotkeys({
      toggleDictation: () => controller!.toggleDictation(),
      snip: () => controller!.snip(),
      scratch: () => controller!.scratch(),
      sectionBreak: () => controller!.sectionBreak(),
      clipboard: () => controller!.clipboardCode(),
      toggleCompact: () => {
        settings.update({ compact: !settings.current.compact })
      }
    })

    if (hotkeys.failed.length) {
      // Another app owns the combination. Say which one, loudly - a hotkey that
      // silently does nothing means lost takes.
      toast(
        'error',
        `Another app already owns ${hotkeys.failed.map((b) => b.label).join(', ')}. Those actions will not respond.`
      )
    }

    syncWindows()

    // Tell the author up front if transcription will not work, rather than
    // after they have narrated twenty steps.
    const avail = await whisper.availability()
    if (!avail.ok) {
      toast(
        'warning',
        `Dictation will record audio but cannot transcribe yet. ${avail.reason}`
      )
    }

    if (isSelfTest && mainWindow) {
      const window = mainWindow
      // A hang here would look like a pass to any CI that only checks output,
      // so bound it explicitly.
      const guard = setTimeout(() => {
        console.error('Self-test timed out inside the app.')
        app.exit(1)
      }, process.env['WC_SELFTEST_COPILOT_CHAT'] === '1' ? 180_000 : 60_000)

      try {
        if (window.webContents.isLoading()) {
          await new Promise<void>((resolve) =>
            window.webContents.once('did-finish-load', () => resolve())
          )
        }
        // Give React a tick to mount before inspecting the DOM.
        await new Promise((resolve) => setTimeout(resolve, 800))
        const { runSelfTest } = await import('./selftest')
        await runSelfTest({ mainWindow: window, controlBar, disposeCopilot: () => copilot.dispose() })
      } catch (err) {
        console.error(`Self-test crashed: ${errorText(err)}`)
        app.exit(1)
      } finally {
        clearTimeout(guard)
      }
      return
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  let quitting = false

  app.on('before-quit', (event) => {
    hotkeys?.unregister()

    // Saves are debounced, so a quit can easily land between the last edit and
    // the write. Hold the quit open until the flush completes rather than
    // firing it off and hoping.
    if (!quitting) {
      quitting = true
      event.preventDefault()
      void (async () => {
        try {
          await store.flush()
          await settings.flush()
          await controller?.dispose()
        } catch (error) {
          console.error(`Could not finish saving: ${errorText(error)}`)
        } finally {
          try {
            await copilot.dispose()
          } catch (error) {
            console.error(`Could not stop Copilot: ${errorText(error)}`)
          }
          disposePlatform()
          app.quit()
        }
      })()
      return
    }

    disposePlatform()
  })
}

export { store, recorder, platform, BINDINGS }
