import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { CH, type AppSettingsInfo, type NewProjectRequest, type RendererApi, type ToastMessage } from '@shared/ipc'
import type { CopilotChatState } from '@shared/copilot'
import type { HudStatus, LoadedProject, OsId, ProjectMeta, Step } from '@shared/types'

/** Subscribe and hand back an unsubscribe function, so React effects stay tidy. */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: RendererApi = {
  project: {
    create: (req: NewProjectRequest) => ipcRenderer.invoke(CH.projectNew, req),
    open: () => ipcRenderer.invoke(CH.projectOpen),
    current: () => ipcRenderer.invoke(CH.projectCurrent),
    saveSteps: (steps: Step[]) => ipcRenderer.invoke(CH.projectSaveSteps, steps),
    saveMeta: (meta: Partial<ProjectMeta>) => ipcRenderer.invoke(CH.projectSaveMeta, meta),
    reveal: () => ipcRenderer.invoke(CH.projectReveal),
    close: () => ipcRenderer.invoke(CH.projectClose),
    onChanged: (cb: (p: LoadedProject | null) => void) => subscribe(CH.onProjectChanged, cb)
  },
  recorder: {
    toggleDictation: () => ipcRenderer.invoke(CH.recorderToggleDictation),
    snip: (stepId?: string) => ipcRenderer.invoke(CH.recorderSnip, stepId),
    scratch: () => ipcRenderer.invoke(CH.recorderScratch),
    sectionBreak: () => ipcRenderer.invoke(CH.recorderBreak),
    clipboard: () => ipcRenderer.invoke(CH.recorderClipboard),
    addManualStep: (narration: string) => ipcRenderer.invoke(CH.recorderAddManualStep, narration),
    removeImage: (imageId: string) => ipcRenderer.invoke(CH.recorderRemoveImage, imageId),
    status: () => ipcRenderer.invoke(CH.recorderStatus),
    retranscribe: (stepId?: string) => ipcRenderer.invoke(CH.recorderRetranscribe, stepId),
    onStatus: (cb: (s: HudStatus) => void) => subscribe(CH.onRecorderStatus, cb)
  },
  whisper: {
    status: () => ipcRenderer.invoke(CH.whisperStatus)
  },
  audio: {
    devices: () => ipcRenderer.invoke(CH.audioDeviceList),
    setDevice: (deviceId: string) => ipcRenderer.invoke(CH.audioDeviceSet, deviceId)
  },
  settings: {
    get: () => ipcRenderer.invoke(CH.settingsGet),
    set: (patch: Partial<AppSettingsInfo>) => ipcRenderer.invoke(CH.settingsSet, patch),
    chooseProjectsDir: () => ipcRenderer.invoke(CH.settingsChooseProjectsDir),
    openProjectsDir: () => ipcRenderer.invoke(CH.settingsOpenProjectsDir),
    onChanged: (cb: (s: AppSettingsInfo) => void) => subscribe(CH.onSettingsChanged, cb)
  },
  ui: {
    setCompact: (compact: boolean) => ipcRenderer.invoke(CH.uiSetCompact, compact),
    showMain: () => ipcRenderer.invoke(CH.uiShowMain),
    moveControlBar: (dx: number, dy: number) => ipcRenderer.invoke(CH.uiMoveControlBar, dx, dy),
    resizeControlBar: (height: number) => ipcRenderer.invoke(CH.uiResizeControlBar, height)
  },
  media: {
    url: (file: string) => ipcRenderer.invoke(CH.mediaUrl, file)
  },
  build: {
    verifyWeb: () => ipcRenderer.invoke(CH.buildVerifyWeb),
    openWeb: () => ipcRenderer.invoke(CH.buildOpenWeb)
  },
  copilot: {
    state: () => ipcRenderer.invoke(CH.copilotState),
    status: () => ipcRenderer.invoke(CH.copilotStatus),
    send: (request) => ipcRenderer.invoke(CH.copilotSend, request),
    stop: (projectPath) => ipcRenderer.invoke(CH.copilotStop, projectPath),
    reset: (projectPath) => ipcRenderer.invoke(CH.copilotReset, projectPath),
    permission: (projectPath, id, approve) =>
      ipcRenderer.invoke(CH.copilotPermission, projectPath, id, approve),
    answer: (projectPath, id, answer) =>
      ipcRenderer.invoke(CH.copilotAnswer, projectPath, id, answer),
    onChanged: (cb: (state: CopilotChatState) => void) => subscribe(CH.onCopilotChanged, cb)
  },
  onToast: (cb: (msg: ToastMessage) => void) => subscribe(CH.onToast, cb),
  platform: process.platform as OsId
}

contextBridge.exposeInMainWorld('api', api)
