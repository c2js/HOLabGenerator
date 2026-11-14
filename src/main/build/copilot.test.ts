import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PermissionRequest, SessionConfig, SessionEvent } from '@github/copilot-sdk'
import type { CopilotChatState, CopilotSendRequest } from '@shared/copilot'
import { createProject } from '../project/store'
import { CONVERSATION_FILE, CopilotConversation, sdkRuntimePath } from './copilot'
import type { LoadedProject } from '@shared/types'

function harness() {
  let handler: ((event: SessionEvent) => void) | undefined
  let config: SessionConfig | undefined
  let latest: CopilotChatState | undefined
  const session = {
    sessionId: 'test-session',
    sendAndWait: vi.fn(async (_options: { prompt: string }, _timeout?: number): Promise<void> => {}),
    abort: vi.fn(async (): Promise<void> => {}),
    disconnect: vi.fn(async (): Promise<void> => {}),
    on: vi.fn((listener: (event: SessionEvent) => void) => {
      handler = listener
      return () => { handler = undefined }
    })
  }
  const client = {
    start: vi.fn(async (): Promise<void> => {}),
    stop: vi.fn(async (): Promise<Error[]> => []),
    getAuthStatus: vi.fn(async () => ({ isAuthenticated: true })),
    listModels: vi.fn(async () => [{ id: 'test-model', name: 'Test model' }]),
    createSession: vi.fn(async (options: SessionConfig) => { config = options; return session }),
    resumeSession: vi.fn(async (_id: string, options: SessionConfig) => { config = options; return session })
  }
  const chat = new CopilotConversation((state) => { latest = state }, () => client)
  return {
    chat, client, session,
    config: () => config!,
    state: () => latest!,
    emit: (event: SessionEvent) => handler?.(event)
  }
}

const readRequest: PermissionRequest = { kind: 'read', path: 'export/guide.md', intention: 'Read the capture' }
const eventBase = { id: 'event-1', parentId: null, timestamp: new Date().toISOString() }

describe('packaged SDK runtime', () => {
  it('uses the real unpacked executable rather than a virtual asar path', () => {
    const root = join('install', 'resources')
    expect(sdkRuntimePath(
      join(root, 'app.asar', 'node_modules', '@github', 'copilot-sdk-win32-x64', 'package.json'),
      'win32-x64'
    )).toBe(join(root, 'app.asar.unpacked', 'node_modules', '@github', 'copilot-sdk-win32-x64',
      'prebuilds', 'win32-x64', 'copilot-runtime.exe'))
  })

  it('keeps development paths unchanged and uses a non-Windows executable name on macOS', () => {
    const root = join('node_modules', '@github', 'copilot-sdk-darwin-arm64')
    expect(sdkRuntimePath(join(root, 'package.json'), 'darwin-arm64')).toBe(
      join(root, 'prebuilds', 'darwin-arm64', 'copilot-runtime')
    )
  })
})

describe('Copilot conversations', () => {
  let dir: string
  let project: LoadedProject
  let h: ReturnType<typeof harness>

  const request = (overrides: Partial<CopilotSendRequest> = {}): CopilotSendRequest => ({
    projectPath: project.path, model: 'test-model', prompt: 'Build this guide', allowTools: false,
    ...overrides
  })

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wc-copilot-test-'))
    project = await createProject(dir, 'Conversation', 'CI', { scaffold: false })
    h = harness()
  })

  afterEach(async () => {
    await h.chat.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  it('streams text, replaces deltas with the final message, and reuses the session for follow-ups', async () => {
    h.session.sendAndWait.mockImplementationOnce(async () => {
      h.emit({ ...eventBase, ephemeral: true, type: 'assistant.message_delta', data: { messageId: 'reply-1', deltaContent: 'Draft' } })
      expect(h.state().messages.at(-1)?.content).toBe('Draft')
      h.emit({ ...eventBase, type: 'assistant.message', data: { messageId: 'reply-1', content: 'Draft complete' } })
    })
    await h.chat.send(project, request())
    await h.chat.send(project, request({ prompt: 'Make the introduction shorter' }))

    expect(h.client.createSession).toHaveBeenCalledTimes(1)
    expect(h.session.sendAndWait).toHaveBeenLastCalledWith(
      { prompt: 'Make the introduction shorter' }, expect.any(Number)
    )
    expect(h.state().messages.filter((message) => message.id === 'reply-1')).toHaveLength(1)
    expect(h.state().messages.find((message) => message.id === 'reply-1')?.content).toBe('Draft complete')
    expect(h.config().workingDirectory).toBe(project.path)
    expect(h.config().skillDirectories).toEqual([join(project.path, '.agents', 'skills')])
    expect(h.state().busy).toBe(false)
  })

  it('persists the transcript and resumes the same SDK session after reopening', async () => {
    await h.chat.send(project, request())
    await h.chat.close()
    const restored = await h.chat.open(project)
    expect(restored.messages[0].content).toBe('Build this guide')
    expect(restored.sessionId).toBe('test-session')

    await h.chat.send(project, request({ prompt: 'Continue revising' }))
    expect(h.client.resumeSession).toHaveBeenCalledWith(
      'test-session', expect.objectContaining({ workingDirectory: project.path, streaming: true })
    )
    const saved = JSON.parse(await readFile(join(project.path, CONVERSATION_FILE), 'utf8'))
    expect(saved.messages.map((message: { content: string }) => message.content)).toEqual([
      'Build this guide', 'Continue revising'
    ])
    expect(saved).not.toHaveProperty('gitHubToken')
  })

  it('asks for permission, binds decisions to the project, and rejects stale decisions', async () => {
    let decision: unknown
    h.session.sendAndWait.mockImplementation(async () => {
      decision = await h.config().onPermissionRequest!(readRequest, { sessionId: 'test-session' })
    })
    const run = h.chat.send(project, request())
    await vi.waitFor(() => expect(h.state()?.permissions).toHaveLength(1))
    const id = h.state().permissions[0].id
    expect(() => h.chat.permission('different-project', id, true)).toThrow(/no longer belongs/)
    h.chat.permission(project.path, id, true)
    await run
    expect(decision).toMatchObject({
      kind: 'attributed',
      result: { kind: 'approve-once' },
      decisionContext: { source: 'human_response' }
    })
    expect(() => h.chat.permission(project.path, id, true)).toThrow(/no longer pending/)
  })

  it('applies automatic approval per turn, but still prompts for managed approvals', async () => {
    let decision: unknown
    h.session.sendAndWait.mockImplementation(async () => {
      decision = await h.config().onPermissionRequest!(readRequest, { sessionId: 'test-session' })
    })
    await h.chat.send(project, request({ allowTools: true }))
    expect(decision).toEqual({ kind: 'approve-once' })

    const manual = h.chat.send(project, request({ allowTools: false }))
    await vi.waitFor(() => expect(h.state()?.permissions).toHaveLength(1))
    h.chat.permission(project.path, h.state().permissions[0].id, false)
    await manual
    expect(decision).toMatchObject({ result: { kind: 'reject' } })

    h.session.sendAndWait.mockImplementation(async () => {
      decision = await h.config().onPermissionRequest!(
        { ...readRequest, managedApprovalRequired: true }, { sessionId: 'test-session' }
      )
    })
    const managed = h.chat.send(project, request({ allowTools: true }))
    await vi.waitFor(() => expect(h.state()?.permissions).toHaveLength(1))
    expect(h.state().permissions[0].managed).toBe(true)
    h.chat.permission(project.path, h.state().permissions[0].id, true)
    await managed
  })

  it('routes agent questions back to the conversation and validates restricted choices', async () => {
    let answer: unknown
    h.session.sendAndWait.mockImplementation(async () => {
      answer = await h.config().onUserInputRequest!(
        { question: 'Which audience?', choices: ['Beginner', 'Advanced'], allowFreeform: false },
        { sessionId: 'test-session' }
      )
    })
    const run = h.chat.send(project, request())
    await vi.waitFor(() => expect(h.state()?.questions).toHaveLength(1))
    const id = h.state().questions[0].id
    expect(() => h.chat.answer(project.path, id, 'Invalid')).toThrow(/offered answers/)
    h.chat.answer(project.path, id, 'Beginner')
    await run
    expect(answer).toMatchObject({ answer: 'Beginner', wasFreeform: false })
    expect(h.state().messages.at(-1)?.content).toBe('Beginner')
  })

  it('stops pending approval work and saves the stopped conversation', async () => {
    h.session.sendAndWait.mockImplementation(async () => {
      await h.config().onPermissionRequest!(readRequest, { sessionId: 'test-session' })
    })
    const run = h.chat.send(project, request())
    await vi.waitFor(() => expect(h.state()?.permissions).toHaveLength(1))
    await h.chat.stop(project.path)
    await run
    expect(h.session.abort).toHaveBeenCalled()
    expect(h.state().busy).toBe(false)
    expect(h.state().activity).toBe('Stopped.')
    expect(h.state().permissions).toEqual([])
    expect(JSON.parse(await readFile(join(project.path, CONVERSATION_FILE), 'utf8')).messages).toHaveLength(1)
  })

  it('does not send a prompt if cancelled during runtime startup', async () => {
    let started: (() => void) | undefined
    h.client.start.mockImplementation(() => new Promise<void>((resolve) => { started = resolve }))
    const run = h.chat.send(project, request())
    await vi.waitFor(() => expect(started).toBeDefined())
    const stop = h.chat.stop(project.path)
    started!()
    await Promise.all([run, stop])
    expect(h.session.sendAndWait).not.toHaveBeenCalled()
    expect(h.state().busy).toBe(false)
  })

  it('aborts and disconnects before closing a project', async () => {
    h.session.sendAndWait.mockImplementation(async () => {
      await h.config().onPermissionRequest!(readRequest, { sessionId: 'test-session' })
    })
    const run = h.chat.send(project, request())
    await vi.waitFor(() => expect(h.state()?.permissions).toHaveLength(1))
    await h.chat.close()
    await run
    expect(h.session.abort).toHaveBeenCalled()
    expect(h.session.disconnect).toHaveBeenCalled()
    const other = await createProject(dir, 'Other', 'CI', { scaffold: false })
    expect((await h.chat.open(other)).messages).toEqual([])
  })

  it('retains the transcript while changing models through SDK resume', async () => {
    await h.chat.send(project, request())
    await h.chat.send(project, request({ model: 'other-model', prompt: 'Revise' }))
    expect(h.session.disconnect).toHaveBeenCalledTimes(1)
    expect(h.client.resumeSession).toHaveBeenCalledWith(
      'test-session', expect.objectContaining({ model: 'other-model' })
    )
    expect(h.state().messages).toHaveLength(2)
  })

  it('surfaces authentication and model errors without pretending a response succeeded', async () => {
    h.client.getAuthStatus.mockResolvedValue({ isAuthenticated: false })
    await h.chat.send(project, request())
    expect(h.state().error).toMatch(/Sign in/)
    expect(h.session.sendAndWait).not.toHaveBeenCalled()

    h.client.getAuthStatus.mockResolvedValue({ isAuthenticated: true })
    h.session.sendAndWait.mockRejectedValue(new Error('Model not available'))
    await h.chat.send(project, request())
    expect(h.state().error).toBe('Model not available')
    expect(h.session.abort).toHaveBeenCalled()
    expect(h.state().busy).toBe(false)
  })

  it('does not silently replace a missing SDK session with an empty one', async () => {
    await h.chat.send(project, request())
    await h.chat.close()
    h.client.resumeSession.mockRejectedValue(new Error('Session not found'))
    await h.chat.send(project, request({ prompt: 'Continue' }))
    expect(h.state().error).toMatch(/Session not found/)
    expect(h.client.createSession).toHaveBeenCalledTimes(1)
  })

  it('preserves unreadable history and archives it on an explicit new conversation', async () => {
    const file = join(project.path, CONVERSATION_FILE)
    await writeFile(file, '{broken JSON', 'utf8')
    await expect(h.chat.open(project)).rejects.toThrow(/Could not load conversation/)
    await expect(h.chat.send(project, request())).rejects.toThrow(/Could not load conversation/)
    expect(await readFile(file, 'utf8')).toBe('{broken JSON')
    await h.chat.reset(project)
    const archive = (await readdir(project.path)).find((name) => name.startsWith('.copilot-conversation-'))
    expect(archive).toBeDefined()
    expect(await readFile(join(project.path, archive!), 'utf8')).toBe('{broken JSON')
    expect((await h.chat.open(project)).messages).toEqual([])
  })

  it('shares concurrent startup and reports connection failures explicitly', async () => {
    const results = await Promise.all([h.chat.status(), h.chat.status()])
    expect(h.client.start).toHaveBeenCalledTimes(1)
    expect(results[0]).toMatchObject({ available: true, authenticated: true })
    h.client.listModels.mockRejectedValue(new Error('Model catalogue unavailable'))
    expect(await h.chat.status()).toMatchObject({
      available: true, authenticated: true, error: 'Model catalogue unavailable'
    })
  })

  it('ignores sub-agent output rather than mixing it into the main reply', async () => {
    h.session.sendAndWait.mockImplementation(async () => {
      h.emit({
        ...eventBase, type: 'assistant.message', agentId: 'child',
        data: { messageId: 'child-reply', content: 'Internal child output' }
      })
    })
    await h.chat.send(project, request())
    expect(h.state().messages).toHaveLength(1)
  })
})
