import { useCallback, useEffect, useRef, useState } from 'react'
import type { ToastMessage } from '@shared/ipc'
import type { HudStatus, LoadedProject } from '@shared/types'

export function useProject(): {
  project: LoadedProject | null
  loading: boolean
  setProject: (p: LoadedProject | null) => void
} {
  const [project, setProject] = useState<LoadedProject | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    void window.api.project.current().then((p) => {
      if (alive) {
        setProject(p)
        setLoading(false)
      }
    })
    const off = window.api.project.onChanged((p) => setProject(p))
    return () => {
      alive = false
      off()
    }
  }, [])

  return { project, loading, setProject }
}

export function useRecorderStatus(): HudStatus {
  const [status, setStatus] = useState<HudStatus>({
    state: 'idle',
    transcript: '',
    stepCount: 0
  })

  useEffect(() => {
    void window.api.recorder.status().then(setStatus)
    return window.api.recorder.onStatus(setStatus)
  }, [])

  return status
}

export interface Toast extends ToastMessage {
  id: number
}

export function useToasts(): { toasts: Toast[]; dismiss: (id: number) => void; push: (t: ToastMessage) => void } {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => {
    setToasts((all) => all.filter((t) => t.id !== id))
  }, [])

  const push = useCallback(
    (msg: ToastMessage) => {
      const id = nextId.current++
      setToasts((all) => [...all, { ...msg, id }])
      setTimeout(() => dismiss(id), msg.kind === 'error' ? 8000 : 4000)
    },
    [dismiss]
  )

  useEffect(() => window.api.onToast(push), [push])

  return { toasts, dismiss, push }
}

/** Resolve a media filename to a displayable `wcmedia://` URL. */
export function useMediaUrl(file: string | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!file) {
      setUrl(null)
      return
    }
    let alive = true
    void window.api.media.url(file).then((u) => {
      if (alive) setUrl(u)
    })
    return () => {
      alive = false
    }
  }, [file])

  return url
}
