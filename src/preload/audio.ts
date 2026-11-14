import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { CH } from '@shared/ipc'

/**
 * A deliberately tiny bridge for the hidden audio host window, so that window
 * can keep context isolation on instead of being handed raw ipcRenderer.
 */
export interface AudioBridge {
  onStart(cb: (deviceId?: string) => void): void
  onStop(cb: () => void): void
  onBeep(cb: (pattern: 'warning' | 'limit') => void): void
  onEnumerate(cb: () => void): void
  sendSegment(pcm: Uint8Array, sampleRate: number): void
  sendLevel(peak: number): void
  sendError(message: string): void
  sendDevices(devices: Array<{ id: string; label: string }>): void
  ready(): void
}

const bridge: AudioBridge = {
  onStart: (cb) => {
    ipcRenderer.on(CH.audioStart, (_e: IpcRendererEvent, deviceId?: string) => cb(deviceId))
  },
  onStop: (cb) => {
    ipcRenderer.on(CH.audioStop, (_e: IpcRendererEvent) => cb())
  },
  onBeep: (cb) => {
    ipcRenderer.on(CH.audioBeep, (_e: IpcRendererEvent, pattern: 'warning' | 'limit') => cb(pattern))
  },
  onEnumerate: (cb) => {
    ipcRenderer.on(CH.audioEnumerate, (_e: IpcRendererEvent) => cb())
  },
  sendSegment: (pcm, sampleRate) => ipcRenderer.send(CH.audioSegment, { pcm, sampleRate }),
  sendLevel: (peak) => ipcRenderer.send(CH.audioLevel, peak),
  sendError: (message) => ipcRenderer.send(CH.audioError, message),
  sendDevices: (devices) => ipcRenderer.send(CH.audioDevices, devices),
  ready: () => ipcRenderer.send(CH.audioReady, true)
}

contextBridge.exposeInMainWorld('audioBridge', bridge)
