import { useEffect, useRef } from 'react'
import type { Step, StepImage } from '@shared/types'
import { stepImages } from '@shared/types'
import { useMediaUrl } from '../hooks'
import type { StepActions } from '../useSteps'

interface Props {
  step: Step
  index: number
  selected: boolean
  onSelect: () => void
  actions: StepActions
  registerCaret: (getCaret: () => number) => void
}

const CALLOUTS: Array<{ value: Step['callout']; label: string }> = [
  { value: undefined, label: 'None' },
  { value: 'note', label: 'Note' },
  { value: 'tip', label: 'Tip' },
  { value: 'warning', label: 'Warning' }
]

export default function StepCard({
  step,
  index,
  selected,
  onSelect,
  actions,
  registerCaret
}: Props): React.JSX.Element {
  const textarea = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!selected) return
    registerCaret(() => textarea.current?.selectionStart ?? step.narration.length)
  }, [selected, registerCaret, step.narration.length])

  return (
    <li
      className={`card ${selected ? 'selected' : ''} ${step.transcribing ? 'transcribing' : ''}`}
      onMouseDown={onSelect}
      data-step-id={step.id}
    >
      <div className="card-gutter">
        <span className="card-index">{index + 1}</span>
      </div>

      <div className="card-main">
        <input
          className="card-title"
          value={step.title ?? ''}
          placeholder="Step title (optional)"
          onChange={(e) => actions.update(step.id, { title: e.target.value || undefined })}
        />

        <textarea
          ref={textarea}
          className="card-narration"
          rows={Math.max(2, Math.ceil(step.narration.length / 68))}
          value={step.narration}
          placeholder={step.transcribing ? 'Transcribing…' : 'What happens in this step?'}
          onChange={(e) => actions.update(step.id, { narration: e.target.value })}
          onFocus={onSelect}
        />

        {step.code ? (
          <div className="card-code">
            <div className="card-code-head">
              <span>{step.code.lang ?? 'code'}</span>
              <button
                className="link-btn"
                onClick={() => actions.update(step.id, { code: undefined })}
              >
                remove
              </button>
            </div>
            <textarea
              className="card-code-text"
              rows={Math.min(10, step.code.text.split('\n').length + 1)}
              value={step.code.text}
              onChange={(e) =>
                actions.update(step.id, { code: { ...step.code!, text: e.target.value } })
              }
            />
          </div>
        ) : null}

        <div className="card-toolbar">
          <label className="mini">
            Callout
            <select
              value={step.callout ?? ''}
              onChange={(e) =>
                actions.setCallout(step.id, (e.target.value || undefined) as Step['callout'])
              }
            >
              {CALLOUTS.map((c) => (
                <option key={c.label} value={c.value ?? ''}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>

          <button
            className={`chip ${step.quizWorthy ? 'on' : ''}`}
            onClick={() => actions.toggle(step.id, 'quizWorthy')}
            title="Ask the AI for a knowledge check here (Q)"
          >
            Quiz
          </button>

          <button
            className={`chip ${step.sectionBreakBefore ? 'on' : ''}`}
            onClick={() => actions.toggle(step.id, 'sectionBreakBefore')}
            title="Start a new section here (B)"
          >
            Section
          </button>

          {step.audio ? (
            <button
              className="chip"
              onClick={() => void window.api.recorder.retranscribe(step.id)}
              title="Re-run speech-to-text over this step's saved audio"
            >
              Re-transcribe
            </button>
          ) : null}

          <span className="spacer" />

          <button className="chip" onClick={() => actions.move(step.id, -1)} title="Move up">
            ↑
          </button>
          <button className="chip" onClick={() => actions.move(step.id, 1)} title="Move down">
            ↓
          </button>
          <button className="chip" onClick={() => actions.mergeUp(step.id)} title="Merge up (M)">
            Merge
          </button>
          <button className="chip danger" onClick={() => actions.remove(step.id)} title="Delete">
            Delete
          </button>
        </div>

        {step.sectionBreakBefore ? (
          <input
            className="card-section-title"
            value={step.sectionTitle ?? ''}
            placeholder="Section title"
            onChange={(e) => actions.update(step.id, { sectionTitle: e.target.value || undefined })}
          />
        ) : null}
      </div>

      <div className="card-media">
        <StepImages step={step} actions={actions} />

        {step.context?.windowTitle || step.context?.processName ? (
          <div className="card-context" title="Captured automatically at snip time">
            {[step.context.processName, step.context.windowTitle].filter(Boolean).join(' · ')}
          </div>
        ) : null}
      </div>
    </li>
  )
}

/**
 * A step's screenshots, plus an always-present slot for adding another.
 *
 * One instruction often needs to show more than one thing - the menu you open
 * and the dialog it produces - and the slot means adding the second is a click
 * rather than a re-record.
 */
function StepImages({ step, actions }: { step: Step; actions: StepActions }): React.JSX.Element {
  const images = stepImages(step)

  return (
    <div className="media-grid">
      {images.map((image) => (
        <StepImageTile key={image.id} step={step} image={image} actions={actions} />
      ))}

      <button
        className="media-slot"
        onClick={() => void window.api.recorder.snip(step.id)}
        title="Snip a screenshot straight into this step (Ctrl+Alt+S)"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M6 2v14a2 2 0 0 0 2 2h14" />
          <path d="M18 22V8a2 2 0 0 0-2-2H2" />
        </svg>
        <span>{images.length === 0 ? 'Add a screenshot' : 'Add another'}</span>
      </button>
    </div>
  )
}

function StepImageTile({
  step,
  image,
  actions
}: {
  step: Step
  image: StepImage
  actions: StepActions
}): React.JSX.Element {
  const url = useMediaUrl(image.file)

  return (
    <figure className="media-tile">
      {url ? <img src={url} alt="" /> : <div className="media-missing">missing</div>}

      <div className="card-media-meta">
        <code>{image.token}</code>
        <span className="tile-actions">
          <button
            className="link-btn"
            title="Move earlier"
            onClick={() => actions.moveImage(step.id, image.id, -1)}
          >
            ←
          </button>
          <button
            className="link-btn"
            title="Move later"
            onClick={() => actions.moveImage(step.id, image.id, 1)}
          >
            →
          </button>
          <button className="link-btn" onClick={() => void window.api.recorder.removeImage(image.id)}>
            remove
          </button>
        </span>
      </div>

      <input
        className="card-caption"
        value={image.caption ?? ''}
        placeholder="Caption (optional)"
        onChange={(e) => actions.setCaption(step.id, image.id, e.target.value || undefined)}
      />
    </figure>
  )
}
