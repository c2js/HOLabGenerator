import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import {
  CopilotClient,
  RuntimeConnection,
  createAttributedPermissionResult,
  type PermissionHandler,
  type ResumeSessionConfig,
  type SessionConfig,
  type SessionEvent
} from '@github/copilot-sdk'
import {
  DEFAULT_COPILOT_MODEL,
  type CopilotChatState,
  type CopilotMessage,
  type CopilotSendRequest,
  type CopilotStatus
} from '@shared/copilot'
import type { LoadedProject } from '@shared/types'

export const CONVERSATION_FILE = '.copilot-conversation.json'
const require = createRequire(import.meta.url)

/** spawn cannot execute a virtual path inside Electron's asar archive. */
export function sdkRuntimePath(manifest: string, runtimePlatform: string): string {
  const root = dirname(manifest).replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
  return join(root, 'prebuilds', runtimePlatform, runtimePlatform.startsWith('win32-')
    ? 'copilot-runtime.exe' : 'copilot-runtime')
}

function createSdkClient(): CopilotClient {
  const platform = `${process.platform}-${process.arch}`
  const path = process.env['COPILOT_CLI_PATH'] || sdkRuntimePath(
    require.resolve(`@github/copilot-sdk-${platform}/package.json`), platform
  )
  return new CopilotClient({
    connection: RuntimeConnection.forStdio({ path }),
    useLoggedInUser: true,
    logLevel: 'error'
  })
}

interface ChatSession {
  sessionId: string
  sendAndWait(options: { prompt: string }, timeout?: number): Promise<unknown>
  abort(): Promise<void>
  disconnect(): Promise<void>
  on(handler: (event: SessionEvent) => void): () => void
}

interface ChatClient {
  start(): Promise<void>
  stop(): Promise<Error[]>
  getAuthStatus(): Promise<{ isAuthenticated: boolean }>
  listModels(): Promise<Array<{ id: string; name: string }>>
  createSession(config: SessionConfig): Promise<ChatSession>
  resumeSession(id: string, config: ResumeSessionConfig): Promise<ChatSession>
}

type PermissionDecision = Awaited<ReturnType<PermissionHandler>>
type UserInputHandler = NonNullable<SessionConfig['onUserInputRequest']>
type UserInputResponse = Awaited<ReturnType<UserInputHandler>>

interface SavedConversation {
  version: 1
  sessionId?: string
  model: string
  messages: CopilotMessage[]
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function freshState(projectPath: string): CopilotChatState {
  return {
    projectPath,
    model: DEFAULT_COPILOT_MODEL,
    messages: [],
    busy: false,
    activity: '',
    permissions: [],
    questions: [],
    revision: 0
  }
}

function isSavedConversation(value: unknown): value is SavedConversation {
  if (!value || typeof value !== 'object') return false
  const data = value as Partial<SavedConversation>
  return data.version === 1 &&
    typeof data.model === 'string' &&
    (data.sessionId === undefined || typeof data.sessionId === 'string') &&
    Array.isArray(data.messages) &&
    data.messages.every((message) => message &&
      typeof message.id === 'string' &&
      (message.role === 'user' || message.role === 'assistant') &&
      typeof message.content === 'string')
}

/** Owns the SDK in the main process; no credentials or runtime objects cross IPC. */
export class CopilotConversation {
  private client: ChatClient | null = null
  private starting: Promise<ChatClient> | null = null
  private state: CopilotChatState | null = null
  private loading: Promise<CopilotChatState> | null = null
  private session: ChatSession | null = null
  private unsubscribe: (() => void) | null = null
  private running: Promise<void> | null = null
  private cancelled = false
  private closing = false
  private saves = Promise.resolve()
  private permissions = new Map<string, (result: PermissionDecision) => void>()
  private questions = new Map<string, {
    resolve: (response: UserInputResponse) => void
    reject: (error: Error) => void
  }>()

  constructor(
    private readonly publish: (state: CopilotChatState) => void,
    private readonly createClient: () => ChatClient = createSdkClient
  ) {}

  private changed(): void {
    if (!this.state) return
    this.state.revision += 1
    this.publish(structuredClone(this.state))
  }

  private async getClient(): Promise<ChatClient> {
    if (this.starting) return this.starting
    if (this.client) return this.client
    const client = this.createClient()
    this.starting = (async () => {
      try {
        await client.start()
        this.client = client
        return client
      } catch (error) {
        await client.stop()
        throw error
      } finally {
        this.starting = null
      }
    })()
    return this.starting
  }

  async status(): Promise<CopilotStatus> {
    let available = false
    let authenticated = false
    try {
      const client = await this.getClient()
      available = true
      authenticated = (await client.getAuthStatus()).isAuthenticated
      const models = authenticated ? await client.listModels() : []
      return {
        available,
        authenticated,
        models: models.map(({ id, name }) => ({ id, name }))
      }
    } catch (error) {
      return { available, authenticated, models: [], error: errorText(error) }
    }
  }

  async open(project: LoadedProject): Promise<CopilotChatState> {
    if (this.closing) throw new Error('The previous conversation is still closing.')
    if (this.state?.projectPath === project.path) {
      if (this.loading) await this.loading
      return structuredClone(this.state)
    }
    if (this.state) throw new Error('Close the previous project conversation first.')
    this.state = freshState(project.path)
    this.loading = (async () => {
      try {
        const file = join(project.path, CONVERSATION_FILE)
        const raw: unknown = JSON.parse(await fs.readFile(file, 'utf8'))
        if (!isSavedConversation(raw)) throw new Error('Unsupported or damaged conversation file.')
        Object.assign(this.state!, {
          sessionId: raw.sessionId,
          model: raw.model,
          messages: raw.messages
        })
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
          this.state!.error = `Could not load conversation: ${errorText(error)}`
          // Do not overwrite a damaged history with a fresh, apparently successful chat.
          throw new Error(this.state!.error)
        }
      } finally {
        this.loading = null
        this.changed()
      }
      return structuredClone(this.state!)
    })()
    return this.loading
  }

  private save(): Promise<void> {
    if (!this.state) return this.saves
    const { projectPath, sessionId, model, messages } = this.state
    const data: SavedConversation = { version: 1, sessionId, model, messages }
    const contents = JSON.stringify(data, null, 2)
    const file = join(projectPath, CONVERSATION_FILE)
    this.saves = this.saves.catch(() => undefined).then(async () => {
      await fs.writeFile(`${file}.tmp`, contents, 'utf8')
      await fs.rename(`${file}.tmp`, file)
    })
    return this.saves
  }

  private requireState(projectPath: string): CopilotChatState {
    if (!this.state || this.state.projectPath !== projectPath || this.closing) {
      throw new Error('This conversation no longer belongs to the open project.')
    }
    return this.state
  }

  async send(project: LoadedProject, request: CopilotSendRequest): Promise<void> {
    if (request.projectPath !== project.path) throw new Error('The open project changed. Send again.')
    if (!request.prompt.trim()) throw new Error('Enter a message first.')
    if (!request.model.trim()) throw new Error('Choose a Copilot model first.')
    await this.open(project)
    const state = this.requireState(project.path)
    if (this.running || state.busy) throw new Error('Wait for the current response or stop it first.')
    if (state.error?.startsWith('Could not load conversation:')) throw new Error(state.error)
    this.cancelled = false
    state.busy = true
    state.error = undefined
    state.activity = 'Connecting to Copilot...'
    state.messages.push({ id: randomUUID(), role: 'user', content: request.prompt })
    this.changed()
    this.running = this.run(project, request)
    try {
      await this.running
    } finally {
      this.running = null
    }
  }

  private async run(project: LoadedProject, request: CopilotSendRequest): Promise<void> {
    const state = this.state!
    try {
      await this.save()
      const client = await this.getClient()
      if (this.cancelled) return
      if (!(await client.getAuthStatus()).isAuthenticated) {
        throw new Error('Sign in to GitHub Copilot on this machine, then retry. An active Copilot entitlement is required.')
      }
      if (this.cancelled) return
      if (this.session && state.model !== request.model.trim()) await this.disconnect()
      state.model = request.model.trim()
      if (!this.session) {
        const config: SessionConfig = {
          model: state.model,
          clientName: 'hands-on-lab-generator',
          workingDirectory: project.path,
          streaming: true,
          includeSubAgentStreamingEvents: false,
          enableConfigDiscovery: false,
          enableFileHooks: false,
          enableSessionStore: false,
          enableHostGitOperations: false,
          enableSkills: true,
          skillDirectories: [join(project.path, '.agents', 'skills')],
          onPermissionRequest: this.permissionHandler(request.allowTools),
          onUserInputRequest: this.questionHandler,
          systemMessage: {
            mode: 'append',
            content: [
              'You help a course author build and revise this project.',
              'Follow .agents/skills/learning-guide-md-to-html/SKILL.md for HTML generation.',
              'Never modify project.json, root media/, export/guide.md, or .copilot-conversation.json.',
              'export/guide.md is an autosaved raw capture, not an editable course source.',
              'Recover HTML edits only to a separate, new Markdown file, preserving all hidden pages and quiz content.',
              'Explain any lossy conversions. Do not claim a recovered document has been imported into the storyboard.'
            ].join(' ')
          }
        }
        if (state.sessionId) {
          try {
            this.session = await client.resumeSession(state.sessionId, config)
          } catch (error) {
            throw new Error(
              `Could not resume this conversation: ${errorText(error)}. ` +
              'If the lesson was copied from another machine, start a new conversation.'
            )
          }
        } else {
          this.session = await client.createSession(config)
        }
        state.sessionId = this.session.sessionId
        this.unsubscribe = this.session.on((event) => this.onEvent(event))
        await this.save()
      }
      if (this.cancelled) {
        await this.session.abort()
        return
      }
      // Permission policy is read per turn, including warm sessions.
      this.allowTools = request.allowTools
      state.activity = 'Copilot is working...'
      this.changed()
      await this.session.sendAndWait({ prompt: request.prompt }, 30 * 60_000)
    } catch (error) {
      if (!this.cancelled) {
        state.error = errorText(error)
        // A timeout/error must not leave the agent writing after the UI says it stopped.
        if (this.session) {
          try {
            await this.session.abort()
          } catch (abortError) {
            state.error += ` Could not stop Copilot: ${errorText(abortError)}`
          }
        }
      }
    } finally {
      this.settlePending()
      state.busy = false
      state.activity = this.cancelled ? 'Stopped.' : ''
      try {
        await this.save()
      } catch (error) {
        state.error = `Could not save conversation: ${errorText(error)}`
      }
      this.changed()
    }
  }

  private allowTools = false

  private permissionHandler(initialAllowTools: boolean): PermissionHandler {
    this.allowTools = initialAllowTools
    return (request, invocation) => {
      if (this.cancelled) return { kind: 'reject', feedback: 'The author stopped this turn.' }
      const promptRequest = invocation.promptRequest
      const managed = (promptRequest && 'managedApprovalRequired' in promptRequest
        ? promptRequest.managedApprovalRequired : request.managedApprovalRequired) ?? false
      if (this.allowTools && !managed) return { kind: 'approve-once' }
      const id = randomUUID()
      return new Promise<PermissionDecision>((resolve) => {
        this.permissions.set(id, resolve)
        this.state!.permissions.push({
          id,
          kind: request.kind,
          details: JSON.stringify(request, null, 2),
          managed
        })
        this.changed()
      })
    }
  }

  private questionHandler: UserInputHandler = (request) => {
    if (this.cancelled) return Promise.reject(new Error('The author stopped this turn.'))
    const id = randomUUID()
    return new Promise<UserInputResponse>((resolve, reject) => {
      this.questions.set(id, { resolve, reject })
      this.state!.questions.push({
        id,
        question: request.question,
        choices: request.choices ?? [],
        allowFreeform: request.allowFreeform ?? true
      })
      this.changed()
    })
  }

  permission(projectPath: string, id: string, approve: boolean): void {
    const state = this.requireState(projectPath)
    const resolve = this.permissions.get(id)
    if (!resolve) throw new Error('That permission request is no longer pending.')
    this.permissions.delete(id)
    state.permissions = state.permissions.filter((permission) => permission.id !== id)
    resolve(createAttributedPermissionResult(
      approve ? { kind: 'approve-once' } : { kind: 'reject', feedback: 'The author declined.' },
      { source: 'human_response', responseCapability: 'interactive', surface: 'sdk', outcome: 'prompted_user' }
    ))
    this.changed()
  }

  answer(projectPath: string, id: string, answer: string): void {
    const state = this.requireState(projectPath)
    const pending = this.questions.get(id)
    const question = state.questions.find((item) => item.id === id)
    if (!pending || !question) throw new Error('That question is no longer pending.')
    if (!answer.trim() || (!question.allowFreeform && !question.choices.includes(answer))) {
      throw new Error('Select one of the offered answers.')
    }
    this.questions.delete(id)
    state.questions = state.questions.filter((item) => item.id !== id)
    state.messages.push({ id: randomUUID(), role: 'user', content: answer })
    pending.resolve({
      answer,
      wasFreeform: !question.choices.includes(answer),
      decisionContext: {
        source: 'human_response', responseCapability: 'interactive', surface: 'sdk', outcome: 'prompted_user'
      }
    })
    this.changed()
  }

  private onEvent(event: SessionEvent): void {
    if (!this.state || this.cancelled || event.agentId) return
    const state = this.state
    if (event.type === 'assistant.message_delta' || event.type === 'assistant.message') {
      if (event.data.parentToolCallId) return
      const id = event.data.messageId
      let message = state.messages.find((item) => item.id === id)
      if (!message) {
        message = { id, role: 'assistant', content: '' }
        state.messages.push(message)
      }
      if (event.type === 'assistant.message_delta') message.content += event.data.deltaContent
      else message.content = event.data.content
    } else if (event.type === 'tool.execution_start') {
      state.activity = `Using ${event.data.toolName}...`
    } else if (event.type === 'session.error') {
      state.error = event.data.message
    } else {
      return
    }
    this.changed()
  }

  private settlePending(): void {
    for (const resolve of this.permissions.values()) {
      resolve({ kind: 'reject', feedback: 'The conversation was stopped or closed.' })
    }
    this.permissions.clear()
    for (const { reject } of this.questions.values()) reject(new Error('The conversation was stopped or closed.'))
    this.questions.clear()
    if (this.state) {
      this.state.permissions = []
      this.state.questions = []
    }
  }

  async stop(projectPath: string): Promise<void> {
    this.requireState(projectPath)
    await this.stopRun()
  }

  private async stopRun(): Promise<void> {
    this.cancelled = true
    this.settlePending()
    if (this.state?.busy) {
      this.state.activity = 'Stopping...'
      this.changed()
      if (this.session) await this.session.abort()
      await this.running
    }
  }

  private async disconnect(): Promise<void> {
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.session) await this.session.disconnect()
    this.session = null
  }

  async reset(project: LoadedProject): Promise<CopilotChatState> {
    await this.open(project)
    if (this.state!.busy) throw new Error('Stop Copilot before starting a new conversation.')
    await this.disconnect()
    try {
      await fs.copyFile(
        join(project.path, CONVERSATION_FILE),
        join(project.path, `.copilot-conversation-${Date.now()}-${randomUUID().slice(0, 8)}.json`)
      )
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error
    }
    this.state = { ...freshState(project.path), revision: this.state!.revision }
    await this.save()
    this.changed()
    return structuredClone(this.state)
  }

  async close(): Promise<void> {
    this.closing = true
    try {
      if (this.loading) await this.loading
      await this.stopRun()
      await this.disconnect()
      await this.saves
      this.state = null
    } finally {
      this.closing = false
    }
  }

  async dispose(): Promise<void> {
    try {
      await this.close()
    } finally {
      if (this.starting) await this.starting
      if (this.client) {
        const errors = await this.client.stop()
        this.client = null
        if (errors.length) throw new Error(errors.map(errorText).join('; '))
      }
    }
  }
}
