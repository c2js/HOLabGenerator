export const DEFAULT_COPILOT_MODEL = 'gpt-5.6-terra'

export const GENERATE_GUIDE_PROMPT = [
  'Read .agents/skills/learning-guide-md-to-html/SKILL.md and follow it.',
  'Regenerate export/web/guide.html from export/guide.md, using export/layout.html',
  'and the existing export/web assets.',
  'Copy only the referenced screenshots from media/ into export/web/media/.'
].join(' ')

export const RECOVER_MARKDOWN_PROMPT = [
  'Recover the edited export/web/guide.html into a separate Markdown authoring document.',
  'Read every page in DOM order, including hidden pages, not just the visible page.',
  'Preserve headings, instructions, exact code and input values, notes, image alt text and captions.',
  'Use web/media/<filename> image links relative to the Markdown file in export/.',
  'Preserve quiz questions, choices, correct answers and feedback as clearly labelled text.',
  'Omit navigation, theme controls, progress indicators, CSS and JavaScript.',
  'Write export/course.recovered.md; if it exists, choose a new numbered filename instead of overwriting it.',
  'Do not modify project.json, export/guide.md, the HTML, or any existing course sources.',
  'Explain any information that cannot be recovered. This is a lossy content recovery, not a storyboard import.'
].join(' ')

export interface CopilotMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
}

export interface CopilotPermission {
  id: string
  kind: string
  details: string
  managed: boolean
}

export interface CopilotQuestion {
  id: string
  question: string
  choices: string[]
  allowFreeform: boolean
}

export interface CopilotChatState {
  projectPath: string
  sessionId?: string
  model: string
  messages: CopilotMessage[]
  busy: boolean
  activity: string
  error?: string
  permissions: CopilotPermission[]
  questions: CopilotQuestion[]
  revision: number
}

export interface CopilotSendRequest {
  projectPath: string
  prompt: string
  model: string
  allowTools: boolean
}

export interface CopilotStatus {
  available: boolean
  authenticated: boolean
  models: Array<{ id: string; name: string }>
  error?: string
}
