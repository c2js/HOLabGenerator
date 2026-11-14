import { useCallback, useState } from 'react'
import type { WebGuideReportInfo } from '@shared/ipc'
import type { LoadedProject } from '@shared/types'
import CopilotChat from './CopilotChat'

interface Props {
  project: LoadedProject
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function Generate({ project }: Props): React.JSX.Element {
  const [web, setWeb] = useState<WebGuideReportInfo | null>(null)
  const [verifying, setVerifying] = useState(false)

  const verify = useCallback(async () => {
    setVerifying(true)
    try {
      setWeb(await window.api.build.verifyWeb())
    } finally {
      setVerifying(false)
    }
  }, [])

  return (
    <div className="generate">
      <CopilotChat key={project.path} project={project} />

      <section className="panel">
        <header className="panel-head">
          <h2>2 · Check what it produced</h2>
          <p>
            The app does not generate this file, so nothing else verifies it. This catches the
            failures that look fine on the machine they were built on and break the moment the
            folder is copied somewhere else.
          </p>
        </header>

        <div className="panel-foot">
          <button className="btn primary" onClick={() => void verify()} disabled={verifying}>
            {verifying ? 'Checking…' : 'Check the guide'}
          </button>
          <button className="btn ghost" onClick={() => void window.api.build.openWeb()}>
            Open the guide
          </button>
        </div>

        {web ? <WebReport report={web} /> : null}
      </section>
    </div>
  )
}

function WebReport({ report }: { report: WebGuideReportInfo }): React.JSX.Element {
  if (!report.exists) {
    return (
      <div className="report warn">
        <strong>Not generated yet</strong>
        <p className="muted">{report.issues[0]?.message}</p>
      </div>
    )
  }

  const problems = report.issues.filter((i) => i.severity === 'error')
  const notes = report.issues.filter((i) => i.severity === 'warning')

  return (
    <div className={`report ${report.ok ? 'ok' : 'warn'}`}>
      <strong>
        {report.ok
          ? `Looks right · ${report.referenced.length} screenshot${report.referenced.length === 1 ? '' : 's'} · ${formatBytes(report.bytes)}`
          : `${problems.length} problem${problems.length === 1 ? '' : 's'} found`}
      </strong>

      {problems.length ? (
        <ul>
          {problems.map((i) => (
            <li key={i.message}>{i.message}</li>
          ))}
        </ul>
      ) : null}

      {notes.length ? (
        <ul className="notes">
          {notes.map((i) => (
            <li key={i.message}>{i.message}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
