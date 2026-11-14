import { FORMAT_ID, stepImages, toSections, type GuideProject, type Step } from '@shared/types'

/**
 * Generates `guide.md` - the intermediate format, and the actual product of
 * this app.
 *
 * The in-app Copilot session reads this file from disk, and authors can also
 * use it with another agent. It must be understandable without surrounding
 * explanation. That drives three choices:
 *
 *   1. Plain Markdown. Every model handles it well; nothing exotic to trip on.
 *   2. A self-describing header comment, so the file explains its own
 *      conventions even when pasted with zero context.
 *   3. Screenshots appear as `{{IMG:step-003}}` tokens. The skill maps these
 *      to source files and copies the referenced images into the web output.
 */

export interface MarkdownOptions {
  /** Include the YAML front matter. Off when embedding into a chat message. */
  frontMatter?: boolean
}

export function renderImageToken(token: string): string {
  return `{{IMG:${token}}}`
}

const HEADER_COMMENT = `<!--
  RAW CAPTURE - not a finished guide.

  This is a recording of someone performing a task while narrating it. Steps
  appear in the exact order they were performed.

  How to read it:
    - "Narration" is verbatim speech-to-text. Expect filler words, false starts
      and transcription errors. Rewrite it into clear instructions.
    - "App" is the window that was in the foreground when the screenshot was
      taken. Use it for context (e.g. "In Microsoft Edge...").
    - "Clipboard" is a command or snippet the author actually copied. Reproduce
      it verbatim - never paraphrase or "correct" it.
    - {{IMG:step-NNN}} marks where a screenshot belongs. Reproduce every token
      exactly once, unchanged, on its own line, in the same position. Do not
      invent tokens and do not drop any.
    - "Author note" is a direct instruction from the author to you.
    - "Suggest a knowledge check here" means the author wants a quiz at that point.
-->`

export function toGuideMarkdown(project: GuideProject, opts: MarkdownOptions = {}): string {
  const { frontMatter = true } = opts
  const out: string[] = []

  if (frontMatter) {
    out.push('---')
    out.push(`title: ${yamlString(project.meta.title)}`)
    if (project.meta.author) out.push(`author: ${yamlString(project.meta.author)}`)
    out.push(`captured: ${project.meta.created.slice(0, 10)}`)
    out.push(`format: ${FORMAT_ID}`)
    if (project.meta.vocabulary.length) {
      out.push(`vocabulary: [${project.meta.vocabulary.map(yamlString).join(', ')}]`)
    }
    out.push('---')
    out.push('')
  }

  out.push(HEADER_COMMENT)
  out.push('')
  out.push(`# ${project.meta.title}`)
  out.push('')

  if (project.steps.length === 0) {
    out.push('_No steps captured yet._')
    out.push('')
    return out.join('\n')
  }

  let stepNumber = 0
  for (const section of toSections(project.steps)) {
    out.push(`## Section: ${section.title}`)
    out.push('')

    for (const step of section.steps) {
      stepNumber += 1
      out.push(...renderStep(step, stepNumber))
      out.push('')
    }
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

function renderStep(step: Step, number: number): string[] {
  const lines: string[] = []
  lines.push(`### Step ${number}${step.title ? `: ${step.title}` : ''}`)

  const app = describeApp(step)
  if (app) lines.push(`- **App:** ${app}`)

  const narration = step.narration.trim()
  lines.push(
    `- **Narration:** ${narration ? `"${narration}"` : '_(none - see the screenshot)_'}`
  )

  if (step.code?.text) {
    const lang = step.code.lang ? ` (${step.code.lang})` : ''
    lines.push(`- **Clipboard${lang}:**`)
    lines.push('')
    lines.push('  ```' + (step.code.lang ?? ''))
    for (const line of step.code.text.split('\n')) lines.push(`  ${line}`)
    lines.push('  ```')
    lines.push('')
  }

  for (const image of stepImages(step)) {
    lines.push(`- ${renderImageToken(image.token)}`)
  }
  if (step.callout) lines.push(`- **Callout:** ${step.callout}`)
  if (step.quizWorthy) lines.push('- **Suggest a knowledge check here.**')

  return lines
}

function describeApp(step: Step): string | null {
  const ctx = step.context
  if (!ctx) return null

  const process = ctx.processName ? friendlyProcess(ctx.processName) : null
  const title = ctx.windowTitle?.trim()

  if (process && title) return `${process} - "${title}"`
  if (process) return process
  if (title) return `"${title}"`
  return null
}

/** Turn raw process names into what a learner would actually be told to open. */
const FRIENDLY: Record<string, string> = {
  msedge: 'Microsoft Edge',
  chrome: 'Google Chrome',
  firefox: 'Mozilla Firefox',
  code: 'Visual Studio Code',
  'code - insiders': 'Visual Studio Code Insiders',
  devenv: 'Visual Studio',
  windowsterminal: 'Windows Terminal',
  powershell: 'Windows PowerShell',
  pwsh: 'PowerShell',
  cmd: 'Command Prompt',
  explorer: 'File Explorer',
  notepad: 'Notepad',
  teams: 'Microsoft Teams',
  outlook: 'Outlook',
  'ms-teams': 'Microsoft Teams'
}

export function friendlyProcess(name: string): string {
  const key = name.toLowerCase().replace(/\.exe$/, '')
  return FRIENDLY[key] ?? name
}

function yamlString(value: string): string {
  return JSON.stringify(value)
}
