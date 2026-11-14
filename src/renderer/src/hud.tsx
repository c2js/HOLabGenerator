import { StrictMode, useCallback, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useRecorderStatus } from './hooks'
import type { HudStatus } from '@shared/types'
import './styles/hud.css'

const LABEL: Record<HudStatus['state'], string> = {
  idle: 'Ready',
  listening: 'Listening',
  transcribing: 'Transcribing',
  capturing: 'Snipping',
  captured: 'Captured',
  error: 'Problem'
}

const HINT: Record<HudStatus['state'], string> = {
  idle: 'Ready - press Dictate or Snip',
  listening: 'Talk through what you are doing',
  transcribing: 'Working on the last take',
  capturing: 'Select a region - or press Snip again to restart',
  captured: 'Annotate and copy or save to replace it',
  error: 'Open the main window for details'
}

/**
 * The floating control bar.
 *
 * Kept to the handful of things worth reaching for mid-demo. Anything that
 * needs reading or editing belongs in the main window, one click away.
 */
function ControlBar(): React.JSX.Element {
  const status = useRecorderStatus()
  const measure = useAutoHeight()
  const listening = status.state === 'listening'
  const capturing = status.state === 'capturing'
  const transcribing = status.state === 'transcribing'

  const message = status.message || status.transcript || HINT[status.state]

  return (
    <div className={`bar ${status.state}`} ref={measure}>
      <DragHandle />

      <div className="bar-status">
        <div className="bar-row">
          <span className="bar-dot" />
          <span className="bar-state">{LABEL[status.state]}</span>
          <span className="bar-steps">
            {status.stepCount} step{status.stepCount === 1 ? '' : 's'}
          </span>
        </div>
        <div className="bar-message" title={message}>
          {message}
        </div>
      </div>

      <div className="bar-actions">
        <Action
          label={listening ? 'Pause' : 'Dictate'}
          hint={transcribing ? 'Waiting for the last take to transcribe' : 'Ctrl+Alt+D'}
          // Colour means "this is happening", not "this is a button". Idle
          // buttons stay plain so the one that is live actually stands out.
          tone={listening ? 'recording' : undefined}
          // Starting a new take while the previous one is still being
          // transcribed would queue work behind itself for no benefit.
          disabled={transcribing}
          onClick={() => void window.api.recorder.toggleDictation()}
        >
          {listening ? <IconPause /> : <IconMic />}
        </Action>

        <Action
          label={capturing ? 'Retry' : 'Snip'}
          hint="Ctrl+Alt+S - press again to restart a snip"
          tone={capturing ? 'accent' : undefined}
          onClick={() => void window.api.recorder.snip()}
        >
          <IconCrop />
        </Action>

        <Action
          label="Section"
          hint="Ctrl+Alt+B"
          onClick={() => void window.api.recorder.sectionBreak()}
        >
          <IconSection />
        </Action>

        <Action
          label="Paste"
          hint="Ctrl+Alt+C - turn whatever you last copied into a code block on this step"
          onClick={() => void window.api.recorder.clipboard()}
        >
          <IconCode />
        </Action>

        <Action
          label="Undo"
          hint="Ctrl+Alt+Z - drop the last step"
          tone="danger"
          onClick={() => void window.api.recorder.scratch()}
        >
          <IconUndo />
        </Action>

        <span className="bar-divider" />

        <Action
          label="Open"
          hint="Show the main window (Ctrl+Alt+M)"
          onClick={() => void window.api.ui.showMain()}
        >
          <IconExpand />
        </Action>
      </div>
    </div>
  )
}

/**
 * The window is deliberately non-focusable so clicking Snip never steals focus
 * from the app being demonstrated. That also rules out `-webkit-app-region:
 * drag`, which needs activation, so dragging is driven from pointer deltas.
 *
 * Pointer *capture* is the part that makes it actually work: without it the
 * events stop the moment the cursor leaves the window, which on a 520px bar is
 * immediately.
 */
function DragHandle(): React.JSX.Element {
  const dragging = useRef(false)
  const last = useRef({ x: 0, y: 0 })

  return (
    <div
      className="bar-grip"
      title="Drag to move"
      onPointerDown={(e) => {
        e.preventDefault()
        dragging.current = true
        last.current = { x: e.screenX, y: e.screenY }
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        if (!dragging.current) return
        const dx = e.screenX - last.current.x
        const dy = e.screenY - last.current.y
        if (!dx && !dy) return
        last.current = { x: e.screenX, y: e.screenY }
        void window.api.ui.moveControlBar(dx, dy)
      }}
      onPointerUp={(e) => {
        dragging.current = false
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId)
        }
      }}
      onPointerCancel={() => {
        dragging.current = false
      }}
    >
      <span />
      <span />
      <span />
    </div>
  )
}

/** Keep the window exactly as tall as its content, at any DPI or font scale. */
function useAutoHeight(): (node: HTMLDivElement | null) => void {
  const observer = useRef<ResizeObserver | null>(null)

  return useCallback((node: HTMLDivElement | null) => {
    observer.current?.disconnect()
    if (!node) return

    const report = (): void => {
      const style = getComputedStyle(node)
      const margin = parseFloat(style.marginTop || '0') + parseFloat(style.marginBottom || '0')
      void window.api.ui.resizeControlBar(Math.ceil(node.scrollHeight + margin))
    }

    observer.current = new ResizeObserver(report)
    observer.current.observe(node)
    report()
  }, [])
}

interface ActionProps {
  label: string
  hint: string
  onClick: () => void
  children: React.ReactNode
  tone?: 'accent' | 'danger' | 'recording'
  disabled?: boolean
}

function Action({ label, hint, onClick, children, tone, disabled }: ActionProps): React.JSX.Element {
  const [flash, setFlash] = useState(false)
  return (
    <button
      className={`bar-btn ${tone ?? ''} ${flash ? 'flash' : ''}`}
      title={`${label} - ${hint}`}
      disabled={disabled}
      onClick={() => {
        // The window never focuses, so a click gives no visual feedback of its
        // own; this supplies it.
        setFlash(true)
        setTimeout(() => setFlash(false), 220)
        onClick()
      }}
    >
      {children}
      <span>{label}</span>
    </button>
  )
}

/* Inline SVG so the bar has no external assets and renders instantly. */

const svg = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const
}

const IconMic = (): React.JSX.Element => (
  <svg {...svg}>
    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3" />
  </svg>
)

const IconPause = (): React.JSX.Element => (
  <svg {...svg}>
    <rect x="6" y="5" width="4" height="14" rx="1" />
    <rect x="14" y="5" width="4" height="14" rx="1" />
  </svg>
)

const IconCrop = (): React.JSX.Element => (
  <svg {...svg}>
    <path d="M6 2v14a2 2 0 0 0 2 2h14" />
    <path d="M18 22V8a2 2 0 0 0-2-2H2" />
  </svg>
)

const IconSection = (): React.JSX.Element => (
  <svg {...svg}>
    <path d="M3 12h18M3 6h10M3 18h10" />
  </svg>
)

const IconCode = (): React.JSX.Element => (
  <svg {...svg}>
    <path d="m16 18 6-6-6-6M8 6l-6 6 6 6" />
  </svg>
)

const IconUndo = (): React.JSX.Element => (
  <svg {...svg}>
    <path d="M3 7v6h6" />
    <path d="M3 13a9 9 0 1 0 3-7.7L3 8" />
  </svg>
)

const IconExpand = (): React.JSX.Element => (
  <svg {...svg}>
    <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
  </svg>
)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ControlBar />
  </StrictMode>
)
