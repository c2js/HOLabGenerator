import { useEffect, useState } from 'react'
import type { AppSettingsInfo, WhisperStatus } from '@shared/ipc'

export function useSettings(): {
  settings: AppSettingsInfo | null
  set: (patch: Partial<AppSettingsInfo>) => Promise<void>
  chooseDir: () => Promise<void>
} {
  const [settings, setSettings] = useState<AppSettingsInfo | null>(null)

  useEffect(() => {
    void window.api.settings.get().then(setSettings)
    return window.api.settings.onChanged(setSettings)
  }, [])

  return {
    settings,
    set: async (patch) => {
      setSettings(await window.api.settings.set(patch))
    },
    chooseDir: async () => {
      const next = await window.api.settings.chooseProjectsDir()
      if (next) setSettings(next)
    }
  }
}

export function useWhisperStatus(): {
  status: WhisperStatus | null
  refresh: () => Promise<void>
} {
  const [status, setStatus] = useState<WhisperStatus | null>(null)

  const refresh = async (): Promise<void> => {
    setStatus(await window.api.whisper.status())
  }

  useEffect(() => {
    void refresh()
  }, [])

  return { status, refresh }
}
