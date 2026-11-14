import { useEffect, useRef, useState } from 'react'
import {
  DEFAULT_COPILOT_MODEL,
  GENERATE_GUIDE_PROMPT,
  RECOVER_MARKDOWN_PROMPT,
  type CopilotChatState,
  type CopilotQuestion,
  type CopilotStatus
} from '@shared/copilot'
import type { LoadedProject } from '@shared/types'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default function CopilotChat({ project }: { project: LoadedProject }): React.JSX.Element {
  const [chat, setChat] = useState<CopilotChatState | null>(null)
  const [model, setModel] = useState(DEFAULT_COPILOT_MODEL)
  const [prompt, setPrompt] = useState(GENERATE_GUIDE_PROMPT)
  const [allowTools, setAllowTools] = useState(false)
  const [status, setStatus] = useState<CopilotStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [confirmReset, setConfirmReset] = useState(false)
  const transcript = useRef<HTMLDivElement>(null)
  const busy = sending || !!chat?.busy

  useEffect(() => {
    let active = true
    const update = (next: CopilotChatState): void => {
      if (!active || next.projectPath !== project.path) return
      setChat((previous) => !previous || next.revision >= previous.revision ? next : previous)
    }
    const unsubscribe = window.api.copilot.onChanged(update)
    void window.api.copilot.state().then((next) => {
      if (!active || !next) return
      update(next)
      setModel(next.model)
      if (next.messages.length) setPrompt((current) => current === GENERATE_GUIDE_PROMPT ? '' : current)
    }).catch((failure: unknown) => {
      if (active) setError(errorText(failure))
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [project.path])

  useEffect(() => {
    const element = transcript.current
    if (element && element.scrollHeight - element.scrollTop - element.clientHeight < 180) {
      element.scrollTop = element.scrollHeight
    }
  }, [chat])

  async function perform(action: () => Promise<unknown>): Promise<void> {
    setError('')
    try {
      await action()
    } catch (failure) {
      setError(errorText(failure))
    }
  }

  async function send(): Promise<void> {
    if (busy || !prompt.trim()) return
    const message = prompt
    setSending(true)
    setPrompt('')
    await perform(() => window.api.copilot.send({
      projectPath: project.path, model, prompt: message, allowTools
    }))
    setAllowTools(false)
    setSending(false)
  }

  return (
    <section className="panel copilot-panel">
      <header className="panel-head">
        <h2>1 - Build and revise with Copilot</h2>
        <p>
          Chat here using the GitHub Copilot JavaScript SDK. Follow-up messages keep the same
          conversation. Copilot works in this project folder with its bundled guide-generation skill.
        </p>
      </header>

      <div className="copilot-settings">
        <label className="field">
          <span>Model</span>
          <input
            list="copilot-models"
            value={model}
            onChange={(event) => setModel(event.target.value)}
            disabled={busy}
            spellCheck={false}
          />
          <datalist id="copilot-models">
            {status?.models.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </datalist>
        </label>
        <button
          className="btn ghost"
          disabled={checking || busy}
          onClick={() => void perform(async () => {
            setChecking(true)
            try {
              setStatus(await window.api.copilot.status())
            } finally {
              setChecking(false)
            }
          })}
        >
          {checking ? 'Checking...' : 'Check connection'}
        </button>
        <button className="btn ghost" onClick={() => void window.api.project.reveal()}>
          Open project folder
        </button>
      </div>

      {status ? (
        <p className="copilot-hint" role="status">
          {status.error ? `Connection error: ${status.error}` :
            !status.available ? 'The Copilot runtime is unavailable.' :
            status.authenticated ? 'Connected using your existing GitHub authentication.' :
            'Sign in to GitHub Copilot on this machine, then check the connection again.'}
        </p>
      ) : null}

      <div className="copilot-transcript" ref={transcript} role="log" aria-label="Copilot conversation" aria-live="polite">
        {!chat?.messages.length ? (
          <p className="copilot-hint">Send the prepared request to build your guide, or ask a question first.</p>
        ) : chat.messages.map((message) => (
          <article className={`copilot-message ${message.role}`} key={message.id}>
            <strong>{message.role === 'user' ? 'You' : 'Copilot'}</strong>
            <div>{message.content}</div>
          </article>
        ))}
      </div>

      {chat?.permissions.map((permission) => (
        <div className="copilot-request" key={permission.id} role="group" aria-label="Tool approval">
          <strong>Allow {permission.kind}?</strong>
          {permission.managed ? <p>Your organisation requires a manual decision for this request.</p> : null}
          <pre>{permission.details}</pre>
          <div className="panel-foot">
            <button className="btn primary" onClick={() => void perform(() =>
              window.api.copilot.permission(project.path, permission.id, true)
            )}>Allow once</button>
            <button className="btn ghost" onClick={() => void perform(() =>
              window.api.copilot.permission(project.path, permission.id, false)
            )}>Deny</button>
          </div>
        </div>
      ))}

      {chat?.questions.map((question) => (
        <Question
          key={question.id}
          question={question}
          answer={(answer) => perform(() => window.api.copilot.answer(project.path, question.id, answer))}
        />
      ))}

      {error || chat?.error ? <p className="copilot-error" role="alert">{error || chat?.error}</p> : null}
      {chat?.activity ? <p className="copilot-hint" role="status">{chat.activity}</p> : null}

      <form onSubmit={(event) => { event.preventDefault(); void send() }}>
        <label className="field wide">
          <span>Message (Ctrl+Enter to send)</span>
          <textarea
            className="copilot-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault()
                event.currentTarget.form?.requestSubmit()
              }
            }}
            disabled={busy}
            rows={5}
          />
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={allowTools}
            disabled={busy}
            onChange={(event) => setAllowTools(event.target.checked)}
          />
          <span>Allow tools automatically for this turn (trusted projects only)</span>
        </label>
        <p className="copilot-hint">
          Otherwise, approve tool requests above. Automatic approval can run commands and modify files;
          the working directory is not a security sandbox. Messages and approved file content are sent
          to GitHub Copilot. Local Whisper transcription remains offline.
        </p>
        <div className="panel-foot">
          <button className="btn primary" type="submit" disabled={busy || !chat || !prompt.trim() || !model.trim()}>
            {busy ? 'Working...' : 'Send'}
          </button>
          <button className="btn ghost" type="button" disabled={!chat?.busy} onClick={() =>
            void perform(() => window.api.copilot.stop(project.path))
          }>Stop</button>
          <button className="btn ghost" type="button" disabled={busy} onClick={() => setPrompt(GENERATE_GUIDE_PROMPT)}>
            Use generation request
          </button>
          <button className="btn ghost" type="button" disabled={busy || !chat} onClick={() => setConfirmReset(!confirmReset)}>
            New conversation
          </button>
        </div>
      </form>

      {confirmReset ? (
        <div className="copilot-request">
          <p>Archive the local transcript and start a fresh conversation? Course files will not change.</p>
          <button className="btn ghost" disabled={busy} onClick={() => void perform(async () => {
            setChat(await window.api.copilot.reset(project.path))
            setConfirmReset(false)
            setAllowTools(false)
            setModel(DEFAULT_COPILOT_MODEL)
            setPrompt(GENERATE_GUIDE_PROMPT)
          })}>Confirm new conversation</button>
        </div>
      ) : null}

      <details className="copilot-recovery">
        <summary>Edited the HTML and want Markdown?</summary>
        <p>
          Content can be recovered, but not losslessly: layout, interactive behaviour and original
          capture metadata do not round-trip. This request writes a separate{' '}
          <code>export/course.recovered.md</code>, including hidden pages and quiz answers.
          It does not import steps into the storyboard. Never edit <code>export/guide.md</code>:
          autosave replaces it. To continue from recovered text, explicitly ask Copilot to use that
          Markdown file; the default generation request still uses the raw capture.
        </p>
        <button className="btn ghost" disabled={busy} onClick={() => setPrompt(RECOVER_MARKDOWN_PROMPT)}>
          Draft a Markdown recovery request
        </button>
      </details>
      <p className="copilot-hint">Chat history is saved with the project. Copilot authentication stays outside it.</p>
    </section>
  )
}

function Question({ question, answer }: {
  question: CopilotQuestion
  answer: (text: string) => Promise<void>
}): React.JSX.Element {
  const [text, setText] = useState('')
  return (
    <form className="copilot-request" onSubmit={(event) => {
      event.preventDefault()
      if (text.trim()) void answer(text)
    }}>
      <strong>{question.question}</strong>
      <div className="panel-foot">
        {question.choices.map((choice) => (
          <button className="btn ghost" type="button" key={choice} onClick={() => void answer(choice)}>{choice}</button>
        ))}
      </div>
      {question.allowFreeform ? (
        <label className="field wide">
          <span>Your answer</span>
          <input value={text} onChange={(event) => setText(event.target.value)} />
          <button className="btn primary" type="submit" disabled={!text.trim()}>Answer</button>
        </label>
      ) : null}
    </form>
  )
}
