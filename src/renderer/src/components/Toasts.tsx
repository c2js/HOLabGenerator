import type { Toast } from '../hooks'

interface Props {
  toasts: Toast[]
  dismiss: (id: number) => void
}

export default function Toasts({ toasts, dismiss }: Props): React.JSX.Element {
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <button key={t.id} className={`toast ${t.kind}`} onClick={() => dismiss(t.id)}>
          {t.text}
        </button>
      ))}
    </div>
  )
}
