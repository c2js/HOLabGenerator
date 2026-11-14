import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readdir, readFile, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProject, openProject, scaffoldProject, ProjectStore } from './store'

let dir: string

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wc-scaffold-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('project scaffolding', () => {
  it('flushes the Markdown handoff before an SDK conversation can read it', async () => {
    const project = await createProject(dir, 'Fresh Capture', 'CI', { scaffold: false })
    const store = new ProjectStore()
    store.set(project)
    try {
      store.update((current) => ({ ...current, meta: { ...current.meta, title: 'Latest captured lesson' } }))
      const firstSave = store.flush()
      const secondSave = store.flush()
      await Promise.all([firstSave, secondSave])
      expect(await readFile(join(project.path, 'export', 'guide.md'), 'utf8')).toContain('# Latest captured lesson')
      expect(JSON.parse(await readFile(join(project.path, 'project.json'), 'utf8')).meta.title).toBe('Latest captured lesson')
    } finally {
      store.dispose()
    }
  })

  it('lays down the structure the skill builds against', async () => {
    const project = await createProject(dir, 'Scaffold Test', 'CI')
    const e = join(project.path, 'export')

    expect(await exists(join(e, 'layout.html'))).toBe(true)
    expect(await exists(join(e, 'web', 'css', 'guide.css'))).toBe(true)
    expect(await exists(join(e, 'web', 'js', 'guide.js'))).toBe(true)
    expect(await exists(join(e, 'web', 'fonts'))).toBe(true)
    expect(await exists(join(e, 'web', 'media'))).toBe(true)
  })

  it('ships the fonts the stylesheet depends on', async () => {
    const project = await createProject(dir, 'Fonts', 'CI')
    const fonts = await readdir(join(project.path, 'export', 'web', 'fonts'))

    expect(fonts.some((f) => f.endsWith('.woff2'))).toBe(true)
  })

  it('starts media empty rather than shipping somebody else\'s captures', async () => {
    const project = await createProject(dir, 'Empty Media', 'CI')
    const media = await readdir(join(project.path, 'export', 'web', 'media'))

    // The skill copies in only the screenshots a guide actually references.
    expect(media).toHaveLength(0)
  })

  it('writes the skill alongside the template', async () => {
    const project = await createProject(dir, 'Skill', 'CI')
    const skill = await readFile(
      join(project.path, '.agents', 'skills', 'learning-guide-md-to-html', 'SKILL.md'),
      'utf8'
    )

    expect(skill).toContain('export/web/guide.html')
    expect(skill).toContain('export/layout.html')
  })

  it('never overwrites an author\'s customised template', async () => {
    const project = await createProject(dir, 'Customised', 'CI')
    const css = join(project.path, 'export', 'web', 'css', 'guide.css')

    await writeFile(css, '/* my house style */', 'utf8')
    await scaffoldProject(project.path)

    // The skill lets authors change the template; re-scaffolding must not undo it.
    expect(await readFile(css, 'utf8')).toBe('/* my house style */')
  })

  it('back-fills the template into a project created before it existed', async () => {
    const project = await createProject(dir, 'Legacy', 'CI')
    await rm(join(project.path, 'export', 'web'), { recursive: true, force: true })
    await rm(join(project.path, 'export', 'layout.html'), { force: true })

    await openProject(project.path)

    expect(await exists(join(project.path, 'export', 'layout.html'))).toBe(true)
    expect(await exists(join(project.path, 'export', 'web', 'css', 'guide.css'))).toBe(true)
  })
})

describe('opening projects written by older versions', () => {
  it('ignores meta fields that no longer exist rather than failing to open', async () => {
    // Real projects on disk still carry `theme` and `promptPreset` from the
    // themes/prompts era. Dropping those fields must not strand the author.
    const project = await createProject(dir, 'Legacy', 'CI')
    const file = join(project.path, 'project.json')
    const parsed = JSON.parse(await readFile(file, 'utf8'))

    parsed.meta.theme = 'default'
    parsed.meta.promptPreset = 'beginner-tutorial'
    await writeFile(file, JSON.stringify(parsed, null, 2), 'utf8')

    const reopened = await openProject(project.path)

    expect(reopened.meta.title).toBe('Legacy')
    expect(reopened.meta.author).toBe('CI')
    expect('theme' in reopened.meta).toBe(false)
    expect('promptPreset' in reopened.meta).toBe(false)
  })
})
