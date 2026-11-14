import { describe, expect, it } from 'vitest'
import { inspectWebGuideHtml } from './verifyWeb'

const HEAD = `<link rel="stylesheet" href="css/guide.css">`
const SCRIPT = `<script src="js/guide.js"></script>`

function page(body: string, head = HEAD): string {
  return `<!doctype html><html><head>${head}</head><body>${body}${SCRIPT}</body></html>`
}

const errors = (html: string): string[] =>
  inspectWebGuideHtml(html)
    .issues.filter((i) => i.severity === 'error')
    .map((i) => i.message)

describe('inspectWebGuideHtml', () => {
  it('accepts a guide that follows the template contract', () => {
    const html = page('<figure><img src="media/step.png" alt="x"></figure>')
    expect(errors(html)).toHaveLength(0)
  })

  it('collects the screenshots the guide references', () => {
    const html = page(
      '<img src="media/a.png"><img src="./media/b.png"><img src="media/c%20d.png">'
    )
    expect(inspectWebGuideHtml(html).referenced.sort()).toEqual(['a.png', 'b.png', 'c d.png'])
  })

  it('rejects a base64 image, which defeats the split-asset layout', () => {
    const html = page('<img src="data:image/png;base64,AAAA">')
    expect(errors(html).join(' ')).toMatch(/base64/i)
  })

  it('rejects inline script and style', () => {
    expect(errors(page('<script>alert(1)</script>')).join(' ')).toMatch(/inline <script>/i)
    expect(errors(page('<style>body{color:red}</style>')).join(' ')).toMatch(/inline <style>/i)
  })

  it('allows the external script and stylesheet themselves', () => {
    expect(errors(page('<p>ok</p>'))).toHaveLength(0)
  })

  it('rejects a remote dependency, which breaks an offline copy', () => {
    const html = page('<p>x</p>', `${HEAD}<link href="https://cdn.example.com/x.css">`)
    expect(errors(html).join(' ')).toMatch(/remote/i)
  })

  it('rejects an absolute filesystem path', () => {
    const html = page('<img src="C:\\Users\\me\\shot.png">')
    expect(errors(html).join(' ')).toMatch(/absolute/i)
  })

  it('notices the stylesheet or runtime being missing', () => {
    const bare = '<!doctype html><html><head></head><body><p>x</p></body></html>'
    const messages = errors(bare).join(' ')

    expect(messages).toMatch(/guide\.css/)
    expect(messages).toMatch(/guide\.js/)
  })

  it('catches tokens the agent forgot to replace', () => {
    expect(errors(page('<p>{{IMG:step-001}}</p>')).join(' ')).toMatch(/unreplaced/i)
  })

  it('treats inline style attributes as a warning, not a failure', () => {
    const report = inspectWebGuideHtml(page('<p style="color:red">x</p>'))

    expect(report.issues.some((i) => i.severity === 'warning')).toBe(true)
    expect(report.issues.some((i) => i.severity === 'error')).toBe(false)
  })
})
