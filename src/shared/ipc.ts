import type { HudStatus, LoadedProject, OsId, ProjectMeta, Step } from './types'
import type { CopilotChatState, CopilotSendRequest, CopilotStatus } from './copilot'

/** IPC channel names. Kept in one place so main, preload and renderer cannot drift. */
export const CH = {
  // renderer -> main (invoke)
  projectNew: 'project:new',
  projectOpen: 'project:open',
  projectCurrent: 'project:current',
  projectSaveSteps: 'project:save-steps',
  projectSaveMeta: 'project:save-meta',
  projectReveal: 'project:reveal',
  projectClose: 'project:close',

  recorderToggleDictation: 'recorder:toggle-dictation',
  recorderSnip: 'recorder:snip',
  recorderScratch: 'recorder:scratch',
  recorderBreak: 'recorder:break',
  recorderClipboard: 'recorder:clipboard',
  recorderStatus: 'recorder:status',
  recorderAddManualStep: 'recorder:add-manual-step',
  recorderRemoveImage: 'recorder:remove-image',

  // main -> audio host window
  audioStart: 'audio:start',
  audioStop: 'audio:stop',
  audioBeep: 'audio:beep',
  audioEnumerate: 'audio:enumerate',
  // audio host window -> main
  audioSegment: 'audio:segment',
  audioError: 'audio:error',
  audioReady: 'audio:ready',
  audioLevel: 'audio:level',
  audioDevices: 'audio:devices',

  mediaUrl: 'media:url',

  buildVerifyWeb: 'build:verify-web',
  buildOpenWeb: 'build:open-web',
  copilotState: 'copilot:state',
  copilotStatus: 'copilot:status',
  copilotSend: 'copilot:send',
  copilotStop: 'copilot:stop',
  copilotReset: 'copilot:reset',
  copilotPermission: 'copilot:permission',
  copilotAnswer: 'copilot:answer',

  whisperStatus: 'whisper:status',
  recorderRetranscribe: 'recorder:retranscribe',
  audioDeviceList: 'audio:device-list',
  audioDeviceSet: 'audio:device-set',

  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  settingsChooseProjectsDir: 'settings:choose-projects-dir',
  settingsOpenProjectsDir: 'settings:open-projects-dir',

  uiSetCompact: 'ui:set-compact',
  uiShowMain: 'ui:show-main',
  uiMoveControlBar: 'ui:move-control-bar',
  uiResizeControlBar: 'ui:resize-control-bar',

  // main -> renderer (send)
  onProjectChanged: 'project:changed',
  onRecorderStatus: 'recorder:status-changed',
  onSettingsChanged: 'settings:changed',
  onToast: 'app:toast',
  onCopilotChanged: 'copilot:changed'
} as const

export interface NewProjectRequest {
  title: string
  author: string
  /** Absolute path of the parent folder; the `.guide` folder is created inside it. */
  parentDir?: string
}

export interface ToastMessage {
  kind: 'info' | 'success' | 'warning' | 'error'
  text: string
}

export interface WhisperStatus {
  ok: boolean
  /** Why transcription is unavailable, phrased as something the author can act on. */
  reason?: string
  modelName?: string
  binaryPath?: string
  searchedIn: string[]
}

export interface RetranscribeResult {
  attempted: number
  succeeded: number
  failed: number
  error?: string
}

export interface AudioDevice {
  id: string
  label: string
}

export interface AppSettingsInfo {
  projectsDir: string
  showMiniBar: boolean
  compact: boolean
  compactOnCreate: boolean
  /** Chosen microphone, or empty for the system default. */
  micDeviceId: string
}

export interface WebGuideIssueInfo {
  severity: 'error' | 'warning'
  message: string
}

export interface WebGuideReportInfo {
  ok: boolean
  exists: boolean
  bytes: number
  issues: WebGuideIssueInfo[]
  referenced: string[]
  missing: string[]
  unreferenced: string[]
  unused: string[]
}

/** The surface exposed on `window.api` by the preload script. */
export interface RendererApi {
  project: {
    create(req: NewProjectRequest): Promise<LoadedProject | null>
    open(): Promise<LoadedProject | null>
    current(): Promise<LoadedProject | null>
    saveSteps(steps: Step[]): Promise<LoadedProject | null>
    saveMeta(meta: Partial<ProjectMeta>): Promise<LoadedProject | null>
    reveal(): Promise<void>
    close(): Promise<void>
    onChanged(cb: (project: LoadedProject | null) => void): () => void
  }
  recorder: {
    toggleDictation(): Promise<void>
    /** Snip into a specific step, or into the capture flow when omitted. */
    snip(stepId?: string): Promise<void>
    scratch(): Promise<void>
    sectionBreak(): Promise<void>
    clipboard(): Promise<void>
    addManualStep(narration: string): Promise<void>
    removeImage(imageId: string): Promise<boolean>
    status(): Promise<HudStatus>
    /** Re-run transcription for one step, or every step with audio but no narration. */
    retranscribe(stepId?: string): Promise<RetranscribeResult>
    onStatus(cb: (status: HudStatus) => void): () => void
  }
  whisper: {
    status(): Promise<WhisperStatus>
  }
  audio: {
    /** Microphones available for dictation. Labels need mic permission once. */
    devices(): Promise<AudioDevice[]>
    setDevice(deviceId: string): Promise<void>
  }
  settings: {
    get(): Promise<AppSettingsInfo>
    set(patch: Partial<AppSettingsInfo>): Promise<AppSettingsInfo>
    /** Opens a folder picker; returns the new settings, or null if cancelled. */
    chooseProjectsDir(): Promise<AppSettingsInfo | null>
    openProjectsDir(): Promise<void>
    onChanged(cb: (settings: AppSettingsInfo) => void): () => void
  }
  ui: {
    setCompact(compact: boolean): Promise<void>
    showMain(): Promise<void>
    /** Nudge the control bar by a delta, used for dragging it around. */
    moveControlBar(dx: number, dy: number): Promise<void>
    /** Report the bar's measured content height so the window can fit it exactly. */
    resizeControlBar(height: number): Promise<void>
  }
  build: {
    /** Check the guide a coding agent produced under export/web. */
    verifyWeb(): Promise<WebGuideReportInfo>
    openWeb(): Promise<void>
  }
  copilot: {
    state(): Promise<CopilotChatState | null>
    status(): Promise<CopilotStatus>
    send(request: CopilotSendRequest): Promise<void>
    stop(projectPath: string): Promise<void>
    reset(projectPath: string): Promise<CopilotChatState>
    permission(projectPath: string, id: string, approve: boolean): Promise<void>
    answer(projectPath: string, id: string, answer: string): Promise<void>
    onChanged(cb: (state: CopilotChatState) => void): () => void
  }
  media: {
    /** Resolve a media-relative filename to a `file://` URL the renderer can display. */
    url(file: string): Promise<string | null>
  }
  onToast(cb: (msg: ToastMessage) => void): () => void
  platform: OsId
}
