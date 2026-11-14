import { useState } from 'react'
import type { HudStatus, LoadedProject } from '@shared/types'
import { toSections } from '@shared/types'
import Storyboard from './Storyboard'
import Review from './Review'
import Generate from './Generate'

interface Props {
  project: LoadedProject
  status: HudStatus
}

const STATE_LABEL: Record<HudStatus['state'], string> = {
  idle: 'Ready',
  listening: 'Listening',
  transcribing: 'Transcribing',
  capturing: 'Waiting for snip',
  captured: 'Captured',
  error: 'Problem'
}

type Tab = 'storyboard' | 'review' | 'generate'

export default function Workspace({ project, status }: Props): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('storyboard')
  const sections = toSections(project.steps)

  return (
    <div className="workspace">
      <header className="topbar">
        <div className="topbar-left">
          <span className={`state-pill ${status.state}`}>
            <span className="dot" />
            {STATE_LABEL[status.state]}
          </span>
          <div className="project-title">
            <strong>{project.meta.title}</strong>
            <span className="muted">
              {project.steps.length} step{project.steps.length === 1 ? '' : 's'} ·{' '}
              {sections.length} section{sections.length === 1 ? '' : 's'}
            </span>
          </div>
        </div>

        <nav className="tabs">
          <button
            className={`tab ${tab === 'storyboard' ? 'active' : ''}`}
            onClick={() => setTab('storyboard')}
          >
            Storyboard
          </button>
          <button
            className={`tab ${tab === 'review' ? 'active' : ''}`}
            onClick={() => setTab('review')}
          >
            Review
          </button>
          <button
            className={`tab ${tab === 'generate' ? 'active' : ''}`}
            onClick={() => setTab('generate')}
          >
            Generate
          </button>
        </nav>

        <div className="topbar-right">
          <IconButton
            label={status.state === 'listening' ? 'Pause' : 'Dictate'}
            hint="Ctrl+Alt+D"
            active={status.state === 'listening'}
            onClick={() => void window.api.recorder.toggleDictation()}
          >
            {status.state === 'listening' ? <IconPause /> : <IconMic />}
          </IconButton>

          <IconButton
            label="Snip"
            hint="Ctrl+Alt+S"
            active={status.state === 'capturing'}
            onClick={() => void window.api.recorder.snip()}
          >
            <IconCrop />
          </IconButton>

          <IconButton
            label="Compact"
            hint="Hide this window and work from the floating bar (Ctrl+Alt+M)"
            onClick={() => void window.api.ui.setCompact(true)}
          >
            <IconMinimise />
          </IconButton>

          <IconButton
            label="Close"
            hint="Close this guide"
            danger
            onClick={() => void window.api.project.close()}
          >
            <IconClose />
          </IconButton>
        </div>
      </header>

      <main className="stage">
        {tab === 'storyboard' ? (
          <Storyboard project={project} />
        ) : tab === 'review' ? (
          <Review project={project} />
        ) : (
          <Generate project={project} />
        )}
      </main>
    </div>
  )
}

interface IconButtonProps {
  label: string
  hint: string
  onClick: () => void
  children: React.ReactNode
  active?: boolean
  danger?: boolean
}

function IconButton({
  label,
  hint,
  onClick,
  children,
  active,
  danger
}: IconButtonProps): React.JSX.Element {
  return (
    <button
      className={`icon-btn ${active ? 'active' : ''} ${danger ? 'danger' : ''}`}
      title={`${label} - ${hint}`}
      onClick={onClick}
    >
      {children}
      <span>{label}</span>
    </button>
  )
}
const svg = {
  width: 17,
  height: 17,
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

const IconMinimise = (): React.JSX.Element => (
  <svg {...svg}>
    <path d="M9 3v6H3M21 15h-6v6M3 9l7-7M21 15l-7 7" />
  </svg>
)

const IconClose = (): React.JSX.Element => (
  <svg {...svg}>
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
)
