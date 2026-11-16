import { useCallback, useEffect, useState } from 'react'
import type { AudioDevice } from '@shared/ipc'
import { useSettings, useWhisperStatus } from '../useSettings'

interface Props {
  onCreated: () => void
  busy: boolean
  setBusy: (b: boolean) => void
}

export default function Welcome({ onCreated, busy, setBusy }: Props): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [author, setAuthor] = useState('')
  const [devices, setDevices] = useState<AudioDevice[]>([])
  const { settings, chooseDir, set } = useSettings()
  const { status: whisper, refresh } = useWhisperStatus()

  const refreshDevices = useCallback(async () => {
    setDevices(await window.api.audio.devices())
  }, [])

  useEffect(() => {
    void refreshDevices()
  }, [refreshDevices])

  async function create(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    if (!title.trim() || busy) return
    setBusy(true)
    try {
      const project = await window.api.project.create({ title: title.trim(), author: author.trim() })
      if (project) onCreated()
    } finally {
      setBusy(false)
    }
  }

  async function open(): Promise<void> {
    setBusy(true)
    try {
      const project = await window.api.project.open()
      if (project) onCreated()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="welcome-brand">
          <span className="dot" />
          Hands On Lab Generator
        </div>
        <h1>Narrate the task once.</h1>
        <p className="lede">
          Talk through what you are doing and grab screenshots with your normal hotkeys. Everything
          lands in order, ready to hand to Copilot and turn into a portable HTML lab guide.
        </p>

        <form onSubmit={create} className="welcome-form">
          <label>
            <span>Guide title</span>
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Deploy an Agent in Foundry"
            />
          </label>
          <label>
            <span>Author</span>
            <input
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              placeholder="Your name"
            />
          </label>

          <div className="folder-row">
            <div className="folder-info">
              <span>Guides are saved in</span>
              <code title={settings?.projectsDir}>{settings?.projectsDir ?? '…'}</code>
            </div>
            <div className="folder-actions">
              <button type="button" className="btn ghost small" onClick={() => void chooseDir()}>
                Change…
              </button>
              <button
                type="button"
                className="btn ghost small"
                onClick={() => void window.api.settings.openProjectsDir()}
              >
                Open
              </button>
            </div>
          </div>

          <label className="check-row">
            <input
              type="checkbox"
              checked={settings?.compactOnCreate ?? true}
              onChange={(e) => void set({ compactOnCreate: e.target.checked })}
            />
            <span>
              Shrink to the floating control bar once created
              <em>Goes straight into authoring, with this window out of the way.</em>
            </span>
          </label>

          <label className="field">
            <span>Microphone</span>
            <select
              value={settings?.micDeviceId ?? ''}
              onChange={(e) => {
                void window.api.audio.setDevice(e.target.value)
                void set({ micDeviceId: e.target.value })
              }}
              onFocus={() => void refreshDevices()}
            >
              <option value="">System default</option>
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
          {devices.length === 0 ? (
            <p className="field-help">
              Device names appear once you have dictated at least once and granted microphone
              access.
            </p>
          ) : null}

          <div className="welcome-actions">
            <button type="submit" className="btn primary" disabled={!title.trim() || busy}>
              Create guide
            </button>
            <button type="button" className="btn ghost" onClick={open} disabled={busy}>
              Open existing…
            </button>
          </div>
        </form>

        <div className={`engine-status ${whisper ? (whisper.ok ? 'ok' : 'warn') : ''}`}>
          {!whisper ? (
            <span>Checking the speech engine…</span>
          ) : whisper.ok ? (
            <span>
              <strong>Transcription ready</strong> · local model <code>{whisper.modelName}</code> ·
              audio never leaves this machine
            </span>
          ) : (
            <div className="engine-missing">
              <strong>Transcription is not available</strong>
              <p>{whisper.reason}</p>
              <p className="muted">
                Dictation still records and still creates the step — you just type the narration. The
                audio is kept, so you can install the engine and re-transcribe afterwards.
              </p>
              <code className="engine-fix">npm run fetch:whisper</code>
              <button className="btn ghost small" onClick={() => void refresh()}>
                Check again
              </button>
            </div>
          )}
        </div>

        <ul className="welcome-hints">
          <li>
            <kbd>Ctrl</kbd>
            <kbd>Alt</kbd>
            <kbd>D</kbd> dictate
          </li>
          <li>
            <kbd>Ctrl</kbd>
            <kbd>Alt</kbd>
            <kbd>S</kbd> snip
          </li>
          <li>
            <kbd>Ctrl</kbd>
            <kbd>Alt</kbd>
            <kbd>Z</kbd> scratch that
          </li>
          <li>
            <kbd>Ctrl</kbd>
            <kbd>Alt</kbd>
            <kbd>B</kbd> section break
          </li>
          <li>
            <kbd>Ctrl</kbd>
            <kbd>Alt</kbd>
            <kbd>C</kbd> clipboard
          </li>
          <li>
            <kbd>Ctrl</kbd>
            <kbd>Alt</kbd>
            <kbd>M</kbd> compact bar
          </li>
        </ul>
      </div>
    </div>
  )
}
