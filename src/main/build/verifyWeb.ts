import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { allImages, type LoadedProject } from '@shared/types'

export interface WebGuideIssue {
  severity: 'error' | 'warning'
  message: string
}

export interface WebGuideReport {
  ok: boolean
  exists: boolean
  bytes: number
  issues: WebGuideIssue[]
  /** Screenshot filenames the guide actually references. */
  referenced: string[]
  /** Referenced but absent from export/web/media. */
  missing: string[]
  /** Sitting in export/web/media but referenced by nothing. */
  unreferenced: string[]
  /** Project screenshots the guide never used. */
  unused: string[]
}

/**
 * Checks the guide a coding agent produced against what the skill promises.
 *
 * The app no longer generates this file, so nothing else verifies it. An agent
 * that quietly inlines a base64 image, drops a screenshot, or links a CDN
 * stylesheet produces something that looks fine on the machine it was built on
 * and breaks the moment the folder is copied elsewhere - which is the entire
 * point of a portable guide.
 */
export function inspectWebGuideHtml(html: string): {
  issues: WebGuideIssue[]
  referenced: string[]
} {
  const issues: WebGuideIssue[] = []

  const error = (message: string): void => {
    issues.push({ severity: 'error', message })
  }
  const warn = (message: string): void => {
    issues.push({ severity: 'warning', message })
  }

  if (!/<link[^>]+href=["'][^"']*css\/guide\.css["']/i.test(html)) {
    error('Does not link css/guide.css.')
  }
  if (!/<script[^>]+src=["'][^"']*js\/guide\.js["']/i.test(html)) {
    error('Does not load js/guide.js.')
  }

  if (/src=["']data:/i.test(html) || /url\(\s*["']?data:/i.test(html)) {
    error('Contains a base64 image; the skill requires files under media/.')
  }

  // A <script src> is fine; a <script> with a body is not.
  const inlineScript = /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i.exec(html)
  if (inlineScript && inlineScript[0].replace(/<\/?script[^>]*>/gi, '').trim()) {
    error('Contains an inline <script>; behaviour belongs in js/guide.js.')
  }

  const inlineStyle = /<style[^>]*>([\s\S]*?)<\/style>/i.exec(html)
  if (inlineStyle && inlineStyle[1].trim()) {
    error('Contains an inline <style>; presentation belongs in css/guide.css.')
  }
  if (/\sstyle=["'][^"']+["']/i.test(html)) {
    warn('Uses inline style attributes, which the template is meant to own.')
  }

  if (/(?:href|src)=["'](?:https?:)?\/\//i.test(html)) {
    error('References a remote resource; the guide must work offline.')
  }
  if (/(?:href|src)=["'](?:[A-Za-z]:[\\/]|file:\/\/)/i.test(html)) {
    error('Contains an absolute filesystem path.')
  }

  const referenced = new Set<string>()
  for (const match of html.matchAll(/(?:src|href)=["']([^"']*media\/[^"']+)["']/gi)) {
    const file = decodeURIComponent(match[1].split('/').pop() ?? '')
    if (file) referenced.add(file)
  }

  if (/\{\{\s*IMG\s*:/i.test(html)) {
    error('Still contains unreplaced {{IMG:...}} tokens.')
  }

  return { issues, referenced: [...referenced] }
}

export async function verifyWebGuide(project: LoadedProject): Promise<WebGuideReport> {
  const webDir = join(project.path, 'export', 'web')
  const guidePath = join(webDir, 'guide.html')
  const mediaDir = join(webDir, 'media')

  let html: string
  try {
    html = await fs.readFile(guidePath, 'utf8')
  } catch {
    return {
      ok: false,
      exists: false,
      bytes: 0,
      issues: [
        {
          severity: 'error',
          message:
            'export/web/guide.html has not been generated yet. Run the skill in your coding agent.'
        }
      ],
      referenced: [],
      missing: [],
      unreferenced: [],
      unused: []
    }
  }

  const { issues, referenced } = inspectWebGuideHtml(html)

  const onDisk = await fs.readdir(mediaDir).catch(() => [] as string[])
  const missing = referenced.filter((file) => !onDisk.includes(file))
  const unreferenced = onDisk.filter((file) => !referenced.includes(file))

  const projectFiles = allImages(project.steps).map((entry) => entry.image.file)
  const unused = projectFiles.filter((file) => !referenced.includes(file))

  for (const file of missing) {
    issues.push({ severity: 'error', message: `References ${file}, which is not in web/media.` })
  }
  for (const file of unreferenced) {
    issues.push({
      severity: 'warning',
      message: `web/media/${file} is not used by the guide.`
    })
  }
  if (unused.length) {
    issues.push({
      severity: 'warning',
      message: `${unused.length} captured screenshot${unused.length === 1 ? '' : 's'} did not make it into the guide.`
    })
  }

  return {
    ok: !issues.some((i) => i.severity === 'error'),
    exists: true,
    bytes: Buffer.byteLength(html, 'utf8'),
    issues,
    referenced,
    missing,
    unreferenced,
    unused
  }
}
