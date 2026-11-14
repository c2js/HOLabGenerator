import { useState } from 'react'
import { useProject, useRecorderStatus, useToasts } from './hooks'
import Welcome from './components/Welcome'
import Toasts from './components/Toasts'
import Workspace from './components/Workspace'

export default function App(): React.JSX.Element {
  const { project, loading } = useProject()
  const status = useRecorderStatus()
  const { toasts, dismiss } = useToasts()
  const [busy, setBusy] = useState(false)

  return (
    <div className="app">
      {loading ? (
        <div className="boot">Loading…</div>
      ) : project ? (
        <Workspace project={project} status={status} />
      ) : (
        <Welcome onCreated={() => undefined} busy={busy} setBusy={setBusy} />
      )}
      <Toasts toasts={toasts} dismiss={dismiss} />
    </div>
  )
}
