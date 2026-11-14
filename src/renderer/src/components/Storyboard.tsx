import { useCallback, useEffect, useRef, useState } from 'react'
import type { LoadedProject, Step } from '@shared/types'
import { useSteps } from '../useSteps'
import StepCard from './StepCard'

interface Props {
  project: LoadedProject
}

/** Typing in a field must not trigger the single-key shortcuts. */
function isTextEntry(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    el.isContentEditable
  )
}

/**
 * Offers to rescue takes that were narrated while the speech engine was
 * missing. The WAV is kept for exactly this reason, so a missing engine costs
 * the author a click rather than a re-record.
 */
function UntranscribedBanner({ steps }: { steps: Step[] }): React.JSX.Element | null {
  const [running, setRunning] = useState(false)
  const pending = steps.filter((s) => s.audio && !s.narration.trim() && !s.transcribing)

  if (pending.length === 0) return null

  return (
    <div className="banner">
      <div>
        <strong>
          {pending.length} step{pending.length === 1 ? ' has' : 's have'} recorded audio but no
          narration
        </strong>
        <p className="muted">
          Usually this means the speech engine was not installed at the time. The audio was kept, so
          it can still be transcribed.
        </p>
      </div>
      <button
        className="btn primary"
        disabled={running}
        onClick={async () => {
          setRunning(true)
          try {
            await window.api.recorder.retranscribe()
          } finally {
            setRunning(false)
          }
        }}
      >
        {running ? 'Transcribing…' : 'Transcribe them now'}
      </button>
    </div>
  )
}

export default function Storyboard({ project }: Props): React.JSX.Element {
  const { steps, actions } = useSteps(project)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const caretGetter = useRef<(() => number) | null>(null)
  const listRef = useRef<HTMLOListElement>(null)

  const selectedIndex = steps.findIndex((s) => s.id === selectedId)

  useEffect(() => {
    if (steps.length === 0) {
      setSelectedId(null)
    } else if (selectedIndex === -1) {
      setSelectedId(steps[Math.min(steps.length - 1, 0)].id)
    }
  }, [steps, selectedIndex])

  const select = useCallback((id: string) => setSelectedId(id), [])

  const registerCaret = useCallback((getter: () => number) => {
    caretGetter.current = getter
  }, [])

  const flash = useCallback((message: string | null) => {
    setHint(message)
    if (message) setTimeout(() => setHint(null), 3500)
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (isTextEntry(e.target) && e.key !== 'Escape') {
        // Split is the one action that only makes sense while the caret is in
        // the narration, so it keeps working from inside a textarea.
        if (!(e.key.toLowerCase() === 's' && (e.ctrlKey || e.metaKey))) return
      }

      const current = steps[selectedIndex]

      switch (e.key.toLowerCase()) {
        case 'j':
        case 'arrowdown': {
          if (e.altKey && current) {
            e.preventDefault()
            actions.move(current.id, 1)
            return
          }
          if (isTextEntry(e.target)) return
          e.preventDefault()
          const next = steps[Math.min(steps.length - 1, selectedIndex + 1)]
          if (next) setSelectedId(next.id)
          return
        }
        case 'k':
        case 'arrowup': {
          if (e.altKey && current) {
            e.preventDefault()
            actions.move(current.id, -1)
            return
          }
          if (isTextEntry(e.target)) return
          e.preventDefault()
          const prev = steps[Math.max(0, selectedIndex - 1)]
          if (prev) setSelectedId(prev.id)
          return
        }
        case 'enter': {
          if (isTextEntry(e.target)) return
          e.preventDefault()
          const el = listRef.current?.querySelector<HTMLTextAreaElement>(
            `[data-step-id="${selectedId}"] .card-narration`
          )
          el?.focus()
          return
        }
        case 'escape': {
          ;(e.target as HTMLElement)?.blur?.()
          return
        }
        case 'm': {
          if (!current) return
          e.preventDefault()
          flash(actions.mergeUp(current.id))
          return
        }
        case 's': {
          if (!current) return
          if (isTextEntry(e.target) && !(e.ctrlKey || e.metaKey)) return
          e.preventDefault()
          const caret = caretGetter.current?.() ?? Math.floor(current.narration.length / 2)
          flash(actions.split(current.id, caret))
          return
        }
        case 'b': {
          if (!current) return
          e.preventDefault()
          actions.toggle(current.id, 'sectionBreakBefore')
          return
        }
        case 'q': {
          if (!current) return
          e.preventDefault()
          actions.toggle(current.id, 'quizWorthy')
          return
        }
        case 'delete': {
          if (!current || isTextEntry(e.target)) return
          e.preventDefault()
          actions.remove(current.id)
          return
        }
        default:
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [steps, selectedIndex, selectedId, actions, flash])

  useEffect(() => {
    if (!selectedId) return
    listRef.current
      ?.querySelector(`[data-step-id="${selectedId}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  if (steps.length === 0) {
    return (
      <div className="empty">
        <h2>Nothing captured yet</h2>
        <p>
          Press <kbd>Ctrl</kbd>
          <kbd>Alt</kbd>
          <kbd>D</kbd> and start talking through the task. Press <kbd>Ctrl</kbd>
          <kbd>Alt</kbd>
          <kbd>S</kbd> whenever a screenshot would help.
        </p>
        <p className="muted">
          Press <kbd>Ctrl</kbd>
          <kbd>Alt</kbd>
          <kbd>M</kbd> to shrink down to the floating control bar so this window stops covering what
          you are demonstrating.
        </p>
      </div>
    )
  }

  return (
    <>
      <UntranscribedBanner steps={steps} />

      <div className="shortcut-bar">
        <span>
          <kbd>J</kbd>
          <kbd>K</kbd> move
        </span>
        <span>
          <kbd>Enter</kbd> edit
        </span>
        <span>
          <kbd>M</kbd> merge up
        </span>
        <span>
          <kbd>S</kbd> split at cursor
        </span>
        <span>
          <kbd>B</kbd> section
        </span>
        <span>
          <kbd>Q</kbd> quiz
        </span>
        <span>
          <kbd>Alt</kbd>+<kbd>J</kbd>/<kbd>K</kbd> reorder
        </span>
        {hint ? <span className="shortcut-hint">{hint}</span> : null}
      </div>

      <ol className="cards" ref={listRef}>
        {steps.map((step, i) => (
          <li key={step.id} className="card-wrap">
            {step.sectionBreakBefore ? (
              <div className="section-divider">
                <span>{step.sectionTitle?.trim() || 'New section'}</span>
              </div>
            ) : null}
            <ol className="card-holder">
              <StepCard
                step={step}
                index={i}
                selected={step.id === selectedId}
                onSelect={() => select(step.id)}
                actions={actions}
                registerCaret={registerCaret}
              />
            </ol>
          </li>
        ))}
      </ol>
    </>
  )
}
