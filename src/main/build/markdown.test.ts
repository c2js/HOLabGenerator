import { describe, expect, it } from 'vitest'
import { toGuideMarkdown, friendlyProcess } from './markdown'
import { FORMAT_VERSION, type GuideProject, type Step } from '@shared/types'

function step(partial: Partial<Step> & { id: string }): Step {
  return { narration: '', at: '2026-08-18T10:00:00.000Z', ...partial }
}

function project(steps: Step[]): GuideProject {
  return {
    formatVersion: FORMAT_VERSION,
    meta: {
      title: 'Deploy an Agent',
      author: 'Joshua',
      created: '2026-08-18T09:00:00.000Z',
      updated: '2026-08-18T09:00:00.000Z',
      vocabulary: ['Entra', 'Foundry']
    },
    steps
  }
}

describe('guide.md generation', () => {
  it('emits front matter the AI can use for titling', () => {
    const md = toGuideMarkdown(project([]))

    expect(md).toContain('title: "Deploy an Agent"')
    expect(md).toContain('format: workshop-capture/v1')
    expect(md).toContain('vocabulary: ["Entra", "Foundry"]')
  })

  it('explains its own conventions so it survives being pasted with no context', () => {
    const md = toGuideMarkdown(project([]))

    expect(md).toContain('RAW CAPTURE')
    expect(md).toContain('{{IMG:step-NNN}}')
    expect(md).toContain('verbatim speech-to-text')
  })

  it('numbers steps continuously across sections', () => {
    const md = toGuideMarkdown(
      project([
        step({ id: '1', narration: 'one' }),
        step({ id: '2', narration: 'two', sectionBreakBefore: true, sectionTitle: 'Assess' }),
        step({ id: '3', narration: 'three' })
      ])
    )

    expect(md).toContain('### Step 1')
    expect(md).toContain('## Section: Assess')
    expect(md).toContain('### Step 2')
    expect(md).toContain('### Step 3')
  })

  it('renders screenshots as tokens and never as image data', () => {
    const md = toGuideMarkdown(
      project([
        step({
          id: '1',
          narration: 'click create agent',
          images: [{ id: 'i25c075', file: 'a.png', token: 'step-001', width: 800, height: 600 }]
        })
      ])
    )

    expect(md).toContain('{{IMG:step-001}}')
    expect(md).not.toContain('a.png')
    expect(md).not.toContain('base64')
  })

  it('includes the foreground app so the AI can write "In Microsoft Edge..."', () => {
    const md = toGuideMarkdown(
      project([
        step({
          id: '1',
          narration: 'go to the portal',
          context: { processName: 'msedge', windowTitle: 'Azure AI Foundry' }
        })
      ])
    )

    expect(md).toContain('**App:** Microsoft Edge - "Azure AI Foundry"')
  })

  it('reproduces a clipboard command in a fenced block', () => {
    const md = toGuideMarkdown(
      project([
        step({
          id: '1',
          narration: 'run this',
          code: { text: 'az login --tenant contoso', lang: 'bash' }
        })
      ])
    )

    expect(md).toContain('**Clipboard (bash):**')
    expect(md).toContain('az login --tenant contoso')
  })

  it('passes the author\'s quiz hint through to the AI', () => {
    const md = toGuideMarkdown(project([step({ id: '1', narration: 'done', quizWorthy: true })]))
    expect(md).toContain('Suggest a knowledge check here')
  })

  it('marks a step with no narration rather than leaving it blank', () => {
    const md = toGuideMarkdown(
      project([
        step({ id: '1', images: [{ id: 'i0f37cd', file: 'a.png', token: 'step-001', width: 10, height: 10 }] })
      ])
    )

    expect(md).toContain('_(none - see the screenshot)_')
  })

  it('says so plainly when nothing has been captured', () => {
    expect(toGuideMarkdown(project([]))).toContain('_No steps captured yet._')
  })
})

describe('friendlyProcess', () => {
  it('maps raw process names to what a learner is told to open', () => {
    expect(friendlyProcess('msedge')).toBe('Microsoft Edge')
    expect(friendlyProcess('Code.exe')).toBe('Visual Studio Code')
  })

  it('passes through anything it does not recognise', () => {
    expect(friendlyProcess('contoso-tool')).toBe('contoso-tool')
  })
})

