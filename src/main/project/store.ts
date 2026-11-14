import { promises as fs } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'
import { app } from 'electron'
import { toGuideMarkdown } from '../build/markdown'
import {
  FORMAT_VERSION,
  renumberImageTokens,
  type GuideProject,
  type LoadedProject,
  type ProjectMeta,
  type Step,
  type StepImage
} from '@shared/types'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const PROJECT_FILE = 'project.json'
export const MEDIA_DIR = 'media'
export const AUDIO_DIR = 'audio'
export const EXPORT_DIR = 'export'
export const GUIDE_SUFFIX = '.guide'
export const SKILL_DIR = join('.agents', 'skills', 'learning-guide-md-to-html')
export const SKILL_FILE = 'SKILL.md'
/** Source of the skill shipped with the app, copied into every new project. */
const SKILL_SOURCE = 'learning-guide-md-to-html-skills.md'
/** Template and runtime the skill expects to find already in the project. */
const LAYOUT_SOURCE = 'layout.html'
const WEB_SOURCE = 'web'

/** Make a string safe to use as a folder name on Windows and macOS. */
export function safeFolderName(title: string): string {
  const cleaned = title
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
  return cleaned || 'Untitled Guide'
}

function emptyProject(title: string, author: string): GuideProject {
  const now = new Date().toISOString()
  return {
    formatVersion: FORMAT_VERSION,
    meta: {
      title: title.trim() || 'Untitled Guide',
      author: author.trim(),
      created: now,
      updated: now,
      vocabulary: []
    },
    steps: []
  }
}

/**
 * Create the folders a project always needs.
 *
 * `audio/` is deliberately absent: recordings are deleted once transcribed, so
 * the folder is only wanted when transcription is unavailable. Dictation
 * creates it on demand, which keeps a normal project free of empty clutter.
 */
async function ensureDirs(root: string): Promise<void> {
  await fs.mkdir(join(root, MEDIA_DIR), { recursive: true })
  await fs.mkdir(join(root, EXPORT_DIR), { recursive: true })
}

/** Locations a bundled resource may live in, in priority order. */
function resourceCandidates(name: string): string[] {
  const candidates: string[] = []
  if (process.resourcesPath) candidates.push(join(process.resourcesPath, name))
  candidates.push(join(__dirname, '../../resources', name))
  candidates.push(join(app.getAppPath(), 'resources', name))
  return candidates
}

async function firstExisting(name: string): Promise<string | null> {
  for (const candidate of resourceCandidates(name)) {
    try {
      await fs.access(candidate)
      return candidate
    } catch {
      continue
    }
  }
  return null
}

/**
 * Drop the HTML-generation skill into the project.
 *
 * The guide is handed to a coding agent rather than this app, so the
 * instructions for turning `guide.md` into the finished tutorial belong *with*
 * the project - the author can open the folder in their agent and it already
 * knows what to do.
 */
export async function writeSkill(root: string): Promise<boolean> {
  const source = await firstExisting(SKILL_SOURCE)
  if (!source) return false

  try {
    const contents = await fs.readFile(source, 'utf8')
    const dir = join(root, SKILL_DIR)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, SKILL_FILE), contents, 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * Lay down the template and runtime the skill builds against:
 *
 *     export/layout.html          the markup and UI contract
 *     export/web/css/guide.css    presentation
 *     export/web/js/guide.js      behaviour
 *     export/web/fonts/           bundled typefaces
 *     export/web/media/           screenshots the finished guide references
 *
 * Nothing here is ever overwritten. The skill explicitly allows an author to
 * customise the template, and re-scaffolding on open must not undo that.
 *
 * `web/media/` is created empty on purpose: the skill copies in only the
 * screenshots a guide actually references, so shipping sample images would
 * leave every new project carrying somebody else's captures.
 */
export async function scaffoldWebTemplate(root: string): Promise<void> {
  const exportDirPath = join(root, EXPORT_DIR)
  await fs.mkdir(join(exportDirPath, 'web', 'media'), { recursive: true })

  const layout = await firstExisting(LAYOUT_SOURCE)
  if (layout) {
    const target = join(exportDirPath, 'layout.html')
    if (!(await pathExists(target))) {
      await fs.copyFile(layout, target).catch(() => undefined)
    }
  }

  const web = await firstExisting(WEB_SOURCE)
  if (!web) return

  try {
    await fs.cp(web, join(exportDirPath, 'web'), {
      recursive: true,
      // Never clobber an author's edits to the template.
      force: false,
      errorOnExist: false,
      filter: (source) => {
        const relative = source.slice(web.length).replace(/\\/g, '/')
        // Keep the media folder, drop whatever sample captures are sitting in it.
        return !/^\/media\/.+/.test(relative)
      }
    })
  } catch {
    // A partially scaffolded template is still usable, and the skill reports
    // anything genuinely missing when it runs.
  }
}

/** Everything a project needs on disk beyond its own captured content. */
export async function scaffoldProject(root: string): Promise<void> {
  await writeSkill(root)
  await scaffoldWebTemplate(root)
}

/** Write atomically so a crash mid-save can never leave a truncated project.json. */
async function writeAtomic(file: string, contents: string): Promise<void> {
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, contents, 'utf8')
  await fs.rename(tmp, file)
}

export interface CreateProjectOptions {
  /**
   * Lay down the skill and web template. On by default; tests that only care
   * about the data model skip it, since copying the template into a temp folder
   * dozens of times is slow and invites disk contention.
   */
  scaffold?: boolean
}

export async function createProject(
  parentDir: string,
  title: string,
  author: string,
  options: CreateProjectOptions = {}
): Promise<LoadedProject> {
  const folder = `${safeFolderName(title)}${GUIDE_SUFFIX}`
  let root = join(parentDir, folder)

  // Never clobber an existing project: fall back to "Name (2).guide".
  let n = 2
  while (await pathExists(root)) {
    root = join(parentDir, `${safeFolderName(title)} (${n})${GUIDE_SUFFIX}`)
    n += 1
  }

  await ensureDirs(root)
  if (options.scaffold !== false) await scaffoldProject(root)
  const project = emptyProject(title, author)
  const loaded = { ...project, path: root }
  await saveProject(loaded)
  return loaded
}

/**
 * Bring a project loaded from disk up to the current shape.
 *
 * Earlier versions stored a single `image` per step. Rewriting it here means
 * the rest of the app only ever deals with the list form, and an older project
 * keeps working instead of silently losing its screenshots.
 */
export function migrateSteps(steps: unknown): Step[] {
  if (!Array.isArray(steps)) return []

  return steps.map((raw) => {
    const step = raw as Step & { image?: StepImage }
    const images = Array.isArray(step.images)
      ? step.images
      : step.image
        ? [step.image]
        : []

    const migrated: Step = {
      ...step,
      images: images.map((image, i) => ({
        ...image,
        id: image.id ?? `${step.id}-img-${i}`
      }))
    }
    delete (migrated as { image?: StepImage }).image
    if (migrated.images?.length === 0) delete migrated.images
    return migrated
  })
}

export async function openProject(root: string): Promise<LoadedProject> {
  const raw = await fs.readFile(join(root, PROJECT_FILE), 'utf8')
  const parsed = JSON.parse(raw) as Partial<GuideProject>

  if (parsed.formatVersion !== FORMAT_VERSION) {
    throw new Error(
      `Unsupported project format v${String(parsed.formatVersion)} - this app understands v${FORMAT_VERSION}.`
    )
  }

  await ensureDirs(root)
  // Projects made before the template existed pick it up here. Nothing is
  // overwritten, so an author's own edits to it survive.
  await scaffoldProject(root)

  const fallbackTitle = basename(root).replace(new RegExp(`\\${GUIDE_SUFFIX}$`), '')
  const now = new Date().toISOString()
  const meta: ProjectMeta = {
    title: parsed.meta?.title || fallbackTitle,
    author: parsed.meta?.author ?? '',
    created: parsed.meta?.created ?? now,
    updated: parsed.meta?.updated ?? now,
    vocabulary: parsed.meta?.vocabulary ?? []
  }

  return {
    formatVersion: FORMAT_VERSION,
    meta,
    steps: renumberImageTokens(migrateSteps(parsed.steps)),
    path: root
  }
}

export async function saveProject(project: LoadedProject): Promise<void> {
  const { path: root, ...data } = project
  await writeAtomic(join(root, PROJECT_FILE), JSON.stringify(data, null, 2))
  await writeAtomic(exportPath(project, 'guide.md'), toGuideMarkdown(project))
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

export function mediaDir(project: LoadedProject): string {
  return join(project.path, MEDIA_DIR)
}

export function audioDir(project: LoadedProject): string {
  return join(project.path, AUDIO_DIR)
}

export function exportDir(project: LoadedProject): string {
  return join(project.path, EXPORT_DIR)
}

export function mediaPath(project: LoadedProject, file: string): string {
  return join(project.path, MEDIA_DIR, file)
}

export function audioPath(project: LoadedProject, file: string): string {
  return join(project.path, AUDIO_DIR, file)
}

export function exportPath(project: LoadedProject, file: string): string {
  return join(project.path, EXPORT_DIR, file)
}

/**
 * Holds the one open project and persists it.
 *
 * Saves are debounced because capture mutates the project on every hotkey press
 * and every finished transcription; we do not want a disk write per keystroke.
 */
export class ProjectStore extends EventEmitter {
  private project: LoadedProject | null = null
  private saveTimer: NodeJS.Timeout | null = null
  private savePending = false
  private saving: Promise<void> | null = null

  get current(): LoadedProject | null {
    return this.project
  }

  set(project: LoadedProject | null): void {
    this.project = project
    this.emit('changed', project)
  }

  /** Replace steps and schedule a save. */
  update(mutate: (p: LoadedProject) => LoadedProject | void): LoadedProject | null {
    if (!this.project) return null
    const result = mutate(this.project)
    if (result) this.project = result
    this.project.meta.updated = new Date().toISOString()
    this.emit('changed', this.project)
    this.scheduleSave()
    return this.project
  }

  setSteps(steps: Step[]): LoadedProject | null {
    return this.update((p) => ({ ...p, steps }))
  }

  scheduleSave(delayMs = 600): void {
    this.savePending = true
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      // flush reports failures through save-error; timer callbacks have no caller.
      void this.flush().catch(() => undefined)
    }, delayMs)
  }

  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    while (this.saving) await this.saving
    if (!this.project || !this.savePending) return
    const project = structuredClone(this.project)
    this.savePending = false
    const saving = saveProject(project)
    this.saving = saving
    try {
      await saving
      this.emit('saved', project)
    } catch (err) {
      this.savePending = true
      this.emit('save-error', err)
      throw err
    } finally {
      this.saving = null
    }
  }

  /**
   * Drop any pending write without performing it.
   *
   * A debounced save that fires after its project folder has gone produces a
   * confusing error from nowhere; tests in particular need to be able to stop
   * the clock before cleaning up.
   */
  dispose(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    this.savePending = false
    this.removeAllListeners()
  }
}
