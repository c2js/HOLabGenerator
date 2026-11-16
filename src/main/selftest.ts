import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { app, screen, type BrowserWindow } from 'electron'
import sharp from 'sharp'
import { CONTROL_BAR_WIDTH } from './windows'

export interface SelfTestContext {
  mainWindow: BrowserWindow
  controlBar: BrowserWindow | null
  disposeCopilot: () => Promise<void>
}

/**
 * Headless self-test, enabled with WC_SELFTEST=1.
 *
 * A GUI app that starts without crashing proves very little - a white screen
 * from a broken preload or a bad asset path looks identical from the outside.
 * This drives the real renderer and asserts the things that actually break:
 * the preload bridge, React mounting, window modes, and the web template and
 * engine resources being findable from wherever the app was launched.
 */
export async function runSelfTest(ctx: SelfTestContext): Promise<void> {
  const window = ctx.mainWindow
  const results: Array<{ name: string; ok: boolean; detail?: string }> = []

  const check = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
    if (process.env['WC_SELFTEST_COPILOT'] === '1') console.log(`[self-test] ${name}`)
    try {
      const detail = await fn()
      results.push({ name, ok: true, detail: detail === undefined ? undefined : String(detail) })
    } catch (err) {
      results.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) })
    }
  }

  const evaluate = async <T>(expression: string): Promise<T> =>
    (await window.webContents.executeJavaScript(expression, true)) as T

  await check('preload bridge is exposed', async () => {
    const keys = await evaluate<string[]>('Object.keys(window.api ?? {})')
    if (!keys.includes('project') || !keys.includes('recorder') || !keys.includes('copilot')) {
      throw new Error(`window.api is missing sections. Got: ${keys.join(', ') || '(nothing)'}`)
    }
    return keys.join(', ')
  })

  await check('React mounted real content', async () => {
    const length = await evaluate<number>(
      'document.getElementById("root")?.innerHTML.length ?? 0'
    )
    if (length < 200) throw new Error(`#root has only ${length} characters - likely a white screen`)
    return `${length} chars`
  })

  await check('welcome screen rendered', async () => {
    const found = await evaluate<boolean>('!!document.querySelector(".welcome-form")')
    if (!found) throw new Error('.welcome-form not found in the DOM')
    return 'ok'
  })

  await check('product branding appears in the app and both windows', async () => {
    const name = 'Hands On Lab Generator'
    const brand = await evaluate<string>('document.querySelector(".welcome-brand")?.textContent.trim()')
    const title = await evaluate<string>('document.title')
    const hudTitle = await ctx.controlBar?.webContents.executeJavaScript('document.title')
    if (app.getName() !== name || brand !== name || title !== name || window.getTitle() !== name ||
      hudTitle !== `${name} HUD`) {
      throw new Error(`Branding mismatch: app=${app.getName()}, welcome=${brand}, title=${title}, HUD=${hudTitle}`)
    }
    return name
  })

  await check('renderer reported no errors', async () => {
    const errors = await evaluate<string[]>('window.__wcErrors ?? []')
    if (errors.length) throw new Error(errors.join(' | '))
    return 'clean'
  })

  await check('IPC round trip works', async () => {
    const status = await evaluate<{ state: string }>(
      'window.api.recorder.status().then(s => ({ state: s.state }))'
    )
    if (!status?.state) throw new Error('recorder.status() returned nothing')
    return `state=${status.state}`
  })

  // --------------------------------------------------------------------
  // End-to-end: capture -> guide.md -> an in-app SDK conversation,
  // driven entirely through the same IPC surface the UI uses.
  // --------------------------------------------------------------------

  const scratchDir = join(app.getPath('temp'), `wc-selftest-${Date.now()}`)
  await fs.mkdir(scratchDir, { recursive: true }).catch(() => undefined)
  const jsonDir = JSON.stringify(scratchDir)

  await check('speech engine is installed and usable', async () => {
    const status = await evaluate<{ ok: boolean; reason?: string; modelName?: string }>(
      'window.api.whisper.status()'
    )
    if (!status.ok) throw new Error(status.reason ?? 'unavailable')
    return `model ${status.modelName}`
  })

  await check('working directory is configurable', async () => {
    const before = await evaluate<{ projectsDir: string }>('window.api.settings.get()')
    const after = await evaluate<{ projectsDir: string }>(
      // compactOnCreate off so the rest of the run is not fighting a hidden window.
      `window.api.settings.set({ projectsDir: ${jsonDir}, compactOnCreate: false })`
    )
    if (after.projectsDir !== scratchDir) {
      throw new Error(`projectsDir did not change (still ${after.projectsDir})`)
    }
    return `was ${before.projectsDir}`
  })

  await check('new guides land in the configured folder', async () => {
    // Deliberately no parentDir: this proves the setting is actually honoured.
    const created = await evaluate<{ path: string } | null>(
      'window.api.project.create({ title: "Self Test Guide", author: "CI" })'
    )
    if (!created?.path) throw new Error('project.create returned nothing')
    if (!created.path.startsWith(scratchDir)) {
      throw new Error(`created in ${created.path}, expected inside ${scratchDir}`)
    }
    return created.path
  })

  await check('captures a step', async () => {
    await evaluate('window.api.recorder.addManualStep("open the portal and select create agent")')
    const count = await evaluate<number>(
      'window.api.project.current().then(p => p ? p.steps.length : 0)'
    )
    if (count !== 1) throw new Error(`expected 1 step, got ${count}`)
    return `${count} step`
  })

  await check('writes guide.md automatically, with no export step', async () => {
    // Nothing calls exportMarkdown here on purpose: an accidental quit must not
    // cost the author the readable copy of what they just recorded.
    const path = await evaluate<string>(
      'window.api.project.current().then(p => p.path)'
    )
    const file = join(path, 'export', 'guide.md')

    let contents = ''
    for (let attempt = 0; attempt < 20; attempt++) {
      await delay(200)
      contents = await fs.readFile(file, 'utf8').catch(() => '')
      if (contents.includes('select create agent')) break
    }

    if (!contents) throw new Error(`guide.md was never written to ${file}`)
    if (!contents.includes('RAW CAPTURE')) throw new Error('guide.md is missing its header')
    if (!contents.includes('select create agent')) {
      throw new Error('guide.md does not contain the captured narration')
    }
    return file
  })

  await check('opens the in-app conversation without the old CLI bridge', async () => {
    const project = await evaluate<{ path: string }>('window.api.project.current()')
    const state = await evaluate<{ projectPath: string; model: string; messages: unknown[] }>(
      'window.api.copilot.state()'
    )
    if (state.projectPath !== project.path || state.messages.length || !state.model) {
      throw new Error('conversation did not start in the open project')
    }
    const hasOldBridge = await evaluate<boolean>(
      '"cliCommand" in window.api.build || "runCli" in window.api.build'
    )
    if (hasOldBridge) throw new Error('the command-launching bridge is still exposed')
    await evaluate(`(() => {
      [...document.querySelectorAll('.tab')].find(button => button.textContent === 'Generate').click()
    })()`)
    await delay(250)
    const visible = await evaluate<boolean>(
      '!!document.querySelector(".copilot-panel textarea") && !document.querySelector(".cli-command")'
    )
    if (!visible) throw new Error('the conversation UI did not render')
    const autoApproved = await evaluate<boolean>(
      'document.querySelector(".copilot-panel input[type=checkbox]").checked'
    )
    if (autoApproved) throw new Error('tool approvals defaulted to automatic')
    if (process.env['WC_SELFTEST_MAIN_SHOT']) {
      await fs.writeFile(process.env['WC_SELFTEST_MAIN_SHOT'], (await window.webContents.capturePage()).toPNG())
    }
    return 'SDK conversation, manual approvals, no terminal launcher'
  })

  if (process.env['WC_SELFTEST_COPILOT'] === '1') {
    await check('the bundled Copilot SDK runtime starts', async () => {
      const result = await evaluate<{ available: boolean; authenticated: boolean; error?: string }>(
        'window.api.copilot.status()'
      )
      if (!result.available) throw new Error(result.error ?? 'runtime unavailable')
      return `runtime available; authenticated=${result.authenticated}`
    })
  }

  if (process.env['WC_SELFTEST_COPILOT_CHAT'] === '1') {
    await check('real SDK conversation streams and remembers a follow-up', async () => {
      const project = await evaluate<{ path: string }>('window.api.project.current()')
      const model = process.env['WC_SELFTEST_COPILOT_MODEL'] || 'gpt-5.6-terra'
      const marker = `HOLAB_SDK_${Date.now()}`
      await evaluate(`window.api.copilot.send(${JSON.stringify({
        projectPath: project.path, model, allowTools: false,
        prompt: `Remember the test marker ${marker}. Reply "Remembered" without using any tools.`
      })})`)
      const first = await evaluate<{ sessionId?: string; error?: string }>('window.api.copilot.state()')
      if (first.error) throw new Error(first.error)
      await evaluate(`window.api.copilot.send(${JSON.stringify({
        projectPath: project.path, model, allowTools: false,
        prompt: 'What test marker did I just ask you to remember? Reply only with that marker, without using tools.'
      })})`)
      const second = await evaluate<{
        sessionId?: string; error?: string; messages: Array<{ role: string; content: string }>
      }>('window.api.copilot.state()')
      if (second.error) throw new Error(second.error)
      if (!first.sessionId || second.sessionId !== first.sessionId) throw new Error('SDK session changed between turns')
      if (!second.messages.some((message) => message.role === 'assistant' && message.content.includes(marker))) {
        throw new Error('The SDK did not return the remembered marker')
      }
      return 'two model turns, same SDK session, remembered synthetic marker'
    })

    if (process.env['WC_SELFTEST_COPILOT_WRITE'] === '1') {
      await check('real SDK tools write inside the synthetic lesson', async () => {
        const project = await evaluate<{ path: string }>('window.api.project.current()')
        await evaluate(`window.api.copilot.send(${JSON.stringify({
          projectPath: project.path,
          model: process.env['WC_SELFTEST_COPILOT_MODEL'] || 'gpt-5.6-terra',
          allowTools: true,
          prompt: 'For this integration check only, create export/sdk-check.txt containing exactly HOLAB_SDK_OK. Do not read other files or run shell commands. Reply briefly when done.'
        })})`)
        const state = await evaluate<{ error?: string }>('window.api.copilot.state()')
        if (state.error) throw new Error(state.error)
        const written = await fs.readFile(join(project.path, 'export', 'sdk-check.txt'), 'utf8')
        if (written.trim() !== 'HOLAB_SDK_OK') throw new Error('SDK file-writing tool did not produce the requested content')
        return 'actual SDK file tool, exact requested content'
      })
    }
  }

  await check('control bar appears once a project is open', async () => {
    if (!ctx.controlBar || ctx.controlBar.isDestroyed()) throw new Error('control bar was not created')
    if (!ctx.controlBar.isVisible()) throw new Error('control bar is not visible')
    if (ctx.controlBar.isFocusable()) {
      // A focusable bar would steal focus from the app being demonstrated,
      // changing what the next snip actually captures.
      throw new Error('control bar is focusable, so clicking it would steal focus')
    }
    return 'visible and non-focusable'
  })

  await check('control bar fits its content', async () => {
    const bar = ctx.controlBar
    if (!bar || bar.isDestroyed()) throw new Error('no control bar')

    // Let the ResizeObserver report and the window settle.
    await delay(600)

    const needed = (await bar.webContents.executeJavaScript(
      `(() => {
         const el = document.querySelector('.bar')
         if (!el) return 0
         const s = getComputedStyle(el)
         return Math.ceil(el.scrollHeight + parseFloat(s.marginTop) + parseFloat(s.marginBottom))
       })()`,
      true
    )) as number

    const [, height] = bar.getSize()
    if (!needed) throw new Error('could not measure the bar')
    if (height < needed) {
      throw new Error(`window is ${height}px but content needs ${needed}px - buttons would be cut off`)
    }

    const clipped = (await bar.webContents.executeJavaScript(
      `(() => {
         const btns = [...document.querySelectorAll('.bar-btn')]
         if (!btns.length) return 'no buttons rendered'
         const limit = document.documentElement.clientHeight
         const over = btns.filter((b) => b.getBoundingClientRect().bottom > limit + 0.5)
         return over.length ? over.length + ' button(s) below the window edge' : ''
       })()`,
      true
    )) as string
    if (clipped) throw new Error(clipped)

    return `${height}px window, ${needed}px content`
  })

  await check('control bar can be moved', async () => {
    const bar = ctx.controlBar
    if (!bar || bar.isDestroyed()) throw new Error('no control bar')

    const [x0, y0] = bar.getPosition()
    await evaluate('window.api.ui.moveControlBar(37, 23)')
    await delay(150)
    const [x1, y1] = bar.getPosition()

    if (x1 - x0 !== 37 || y1 - y0 !== 23) {
      throw new Error(`expected a (37, 23) shift, got (${x1 - x0}, ${y1 - y0})`)
    }

    await evaluate('window.api.ui.moveControlBar(-37, -23)')
    return 'moves by exact deltas'
  })

  await check('dragging the control bar preserves its size on every display', async () => {
    const bar = ctx.controlBar
    if (!bar || bar.isDestroyed()) throw new Error('no control bar')
    const original = bar.getBounds()
    const scales: number[] = []

    try {
      for (const display of screen.getAllDisplays()) {
        const area = display.workArea
        bar.setBounds({
          x: area.x + Math.round((area.width - CONTROL_BAR_WIDTH) / 2),
          y: area.y + Math.round((area.height - original.height) / 2),
          width: CONTROL_BAR_WIDTH,
          height: original.height
        })
        await delay(200)
        const before = bar.getBounds()

        for (let i = 0; i < 80; i++) {
          const delta = i % 2 ? -1 : 1
          await evaluate(`window.api.ui.moveControlBar(${delta}, ${delta})`)
        }
        await delay(200)

        const after = bar.getBounds()
        // DIP/physical-pixel conversion can round once, but must never accumulate.
        if (Math.abs(after.width - CONTROL_BAR_WIDTH) > 1 ||
          Math.abs(after.width - before.width) > 1 ||
          Math.abs(after.height - before.height) > 1) {
          throw new Error(
            `At ${display.scaleFactor * 100}% scale, 80 moves changed ` +
            `${before.width}x${before.height} to ${after.width}x${after.height}`
          )
        }
        scales.push(display.scaleFactor)
      }
    } finally {
      bar.setBounds(original)
    }

    return `80 moves per display; scale factors ${scales.join(', ')}`
  })

  await check('scaffolds the HTML-generation skill into the project', async () => {
    const project = await evaluate<{ path: string }>('window.api.project.current()')
    const skill = join(project.path, '.agents', 'skills', 'learning-guide-md-to-html', 'SKILL.md')

    const contents = await fs.readFile(skill, 'utf8').catch(() => '')
    if (!contents) throw new Error(`SKILL.md was not written to ${skill}`)
    if (!contents.includes('learning-guide-md-to-html')) {
      throw new Error('SKILL.md does not look like the shipped skill')
    }
    return `${(contents.length / 1024).toFixed(1)} KB`
  })

  await check('scaffolds the web template the skill builds against', async () => {
    const project = await evaluate<{ path: string }>('window.api.project.current()')
    const e = join(project.path, 'export')

    const required = [
      join(e, 'layout.html'),
      join(e, 'web', 'css', 'guide.css'),
      join(e, 'web', 'js', 'guide.js'),
      join(e, 'web', 'media')
    ]

    for (const path of required) {
      const ok = await fs
        .access(path)
        .then(() => true)
        .catch(() => false)
      if (!ok) throw new Error(`missing ${path}`)
    }

    const fonts = await fs.readdir(join(e, 'web', 'fonts')).catch(() => [] as string[])
    if (!fonts.some((f) => f.endsWith('.woff2'))) throw new Error('fonts were not scaffolded')

    const media = await fs.readdir(join(e, 'web', 'media')).catch(() => [] as string[])
    if (media.length) throw new Error(`web/media should start empty, found ${media.length} file(s)`)

    return 'layout, css, js, fonts, empty media'
  })

  await check('does not create an audio folder it does not need', async () => {
    const project = await evaluate<{ path: string }>('window.api.project.current()')
    const audio = join(project.path, 'audio')

    // Recordings are deleted once transcribed, so the folder should only appear
    // when transcription is unavailable and audio is actually being kept.
    const exists = await fs
      .access(audio)
      .then(() => true)
      .catch(() => false)
    if (exists) throw new Error('audio/ was created up front')
    return 'absent until needed'
  })

  await check('supports several screenshots on one step', async () => {
    const project = await evaluate<{ path: string }>('window.api.project.current()')
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120">
         <rect width="200" height="120" fill="#dde"/></svg>`
    )
    await sharp(svg).png().toFile(join(project.path, 'media', 'extra-a.png'))
    await sharp(svg).png().toFile(join(project.path, 'media', 'extra-b.png'))

    const tokens = await evaluate<string[]>(`(async () => {
      const p = await window.api.project.current()
      const steps = p.steps.map((s, i) => i === 0
        ? { ...s, images: [
            { id: 'multi-a', file: 'extra-a.png', token: 'x', width: 200, height: 120 },
            { id: 'multi-b', file: 'extra-b.png', token: 'x', width: 200, height: 120 }
          ] }
        : s)
      const saved = await window.api.project.saveSteps(steps)
      return saved.steps[0].images.map(i => i.token)
    })()`)

    if (tokens.length !== 2) throw new Error(`expected 2 images, got ${tokens.length}`)
    if (tokens[0] !== 'step-001' || tokens[1] !== 'step-002') {
      throw new Error(`tokens did not renumber across images: ${tokens.join(', ')}`)
    }
    return tokens.join(', ')
  })


  await check('idle state reads as ready, without tinting every button', async () => {
    const bar = ctx.controlBar
    if (!bar || bar.isDestroyed()) throw new Error('no control bar')
    await delay(300)

    const look = (await bar.webContents.executeJavaScript(
      `(() => {
         const dot = getComputedStyle(document.querySelector('.bar-dot')).backgroundColor
         const state = getComputedStyle(document.querySelector('.bar-state')).color
         const buttons = [...document.querySelectorAll('.bar-btn')].map((b) => ({
           label: (b.querySelector('span') || {}).textContent || '',
           border: getComputedStyle(b).borderTopColor
         }))
         return { dot, state, buttons }
       })()`,
      true
    )) as { dot: string; state: string; buttons: Array<{ label: string; border: string }> }

    const rgb = (value: string): number[] =>
      (value.match(/\d+/g) ?? []).slice(0, 3).map(Number)

    const [dr, dg, db] = rgb(look.dot)
    // Blue means ready: clearly blue-dominant, not the old neutral grey.
    if (!(db > 180 && db - dr > 60 && db - dg > 40)) {
      throw new Error(`the ready dot is not blue (${look.dot})`)
    }

    // The buttons must stay plain, or a permanent tint stops meaning anything.
    const tinted = look.buttons.filter((b) => {
      const [r, g, bl, a] = (b.border.match(/[\d.]+/g) ?? []).map(Number)
      const transparent = a === 0 || (r === 0 && g === 0 && bl === 0)
      return !transparent
    })
    if (tinted.length) {
      throw new Error(`buttons still tinted while idle: ${tinted.map((t) => t.label).join(', ')}`)
    }

    if (process.env['WC_SELFTEST_SHOT']) {
      const shot = await bar.webContents.capturePage()
      await fs.writeFile(process.env['WC_SELFTEST_SHOT'], shot.toPNG())
    }

    return `dot ${look.dot}, ${look.buttons.length} plain buttons`
  })

  await check('microphone selection is available', async () => {
    const devices = await evaluate<Array<{ id: string; label: string }>>(
      'window.api.audio.devices()'
    )
    if (!Array.isArray(devices)) throw new Error('devices() did not return a list')

    // Selecting a device must round-trip through settings so it survives a restart.
    await evaluate('window.api.audio.setDevice("")')
    const s = await evaluate<{ micDeviceId: string }>('window.api.settings.get()')
    if (s.micDeviceId !== '') throw new Error('device choice did not persist')

    return `${devices.length} input(s) visible`
  })

  await check('checks the guide a coding agent produces', async () => {
    const project = await evaluate<{ path: string }>('window.api.project.current()')
    const webDir = join(project.path, 'export', 'web')

    const before = await evaluate<{ exists: boolean; ok: boolean }>(
      'window.api.build.verifyWeb()'
    )
    if (before.exists) throw new Error('reported a guide before one was generated')

    // Stand in for the agent: a guide that follows the contract.
    await fs.writeFile(join(webDir, 'media', 'shot.png'), 'x')
    await fs.writeFile(
      join(webDir, 'guide.html'),
      '<!doctype html><html><head><link rel="stylesheet" href="css/guide.css"></head>' +
        '<body><img src="media/shot.png" alt="x"><script src="js/guide.js"></script></body></html>',
      'utf8'
    )

    const good = await evaluate<{ ok: boolean; referenced: string[] }>(
      'window.api.build.verifyWeb()'
    )
    if (!good.ok) throw new Error('rejected a guide that follows the contract')
    if (!good.referenced.includes('shot.png')) throw new Error('did not find the screenshot')

    // Now one that would break the moment the folder is copied elsewhere.
    await fs.writeFile(
      join(webDir, 'guide.html'),
      '<!doctype html><html><head><link rel="stylesheet" href="css/guide.css">' +
        '<link href="https://cdn.example.com/x.css"></head>' +
        '<body><img src="data:image/png;base64,AA"><script src="js/guide.js"></script></body></html>',
      'utf8'
    )

    const bad = await evaluate<{ ok: boolean; issues: Array<{ message: string }> }>(
      'window.api.build.verifyWeb()'
    )
    if (bad.ok) throw new Error('accepted a base64 image and a remote stylesheet')

    const messages = bad.issues.map((i) => i.message).join(' ')
    if (!/base64/i.test(messages) || !/remote/i.test(messages)) {
      throw new Error(`did not name the problems: ${messages}`)
    }

    await fs.rm(join(webDir, 'guide.html'), { force: true })
    await fs.rm(join(webDir, 'media', 'shot.png'), { force: true })
    return 'accepts good, rejects broken'
  })

  await check('minimising sticks while the project keeps changing', async () => {
    if (window.isMinimized()) window.restore()
    await delay(150)

    window.minimize()
    await delay(250)

    // Editing fires project-changed, which used to call show() and pop the
    // window straight back up - the reported "cannot minimise" bug.
    await evaluate('window.api.recorder.addManualStep("another step while minimised")')
    await delay(600)

    if (!window.isMinimized()) throw new Error('the window un-minimised itself')

    window.restore()
    await delay(200)
    return 'stays minimised'
  })

  await check('compact mode hides the main window', async () => {
    await evaluate('window.api.ui.setCompact(true)')
    await delay(250)
    if (window.isVisible()) throw new Error('main window was still visible in compact mode')
    if (!ctx.controlBar?.isVisible()) throw new Error('control bar disappeared in compact mode')

    await evaluate('window.api.ui.showMain()')
    await delay(250)
    if (!window.isVisible()) throw new Error('main window did not come back')
    return 'hides and restores'
  })


  await check('closes the project cleanly', async () => {
    await evaluate('window.api.project.close()')
    const current = await evaluate<unknown>('window.api.project.current()')
    if (current) throw new Error('project was still open after close')
    return 'closed'
  })

  await check('drops into the control bar when asked to on create', async () => {
    await evaluate('window.api.settings.set({ compactOnCreate: true })')
    await evaluate(
      `window.api.project.create({ title: "Compact On Create", author: "CI", parentDir: ${jsonDir} })`
    )
    await delay(400)

    if (window.isVisible()) throw new Error('the main window stayed up after creating a guide')
    if (!ctx.controlBar?.isVisible()) throw new Error('the control bar did not take over')

    await evaluate('window.api.ui.showMain()')
    await evaluate('window.api.project.close()')
    await delay(200)
    return 'hides on create'
  })

  await check('shuts down the Copilot runtime cleanly', () => ctx.disposeCopilot())
  await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => undefined)

  const passed = results.filter((r) => r.ok).length
  const report = [
    `Hands On Lab Generator self-test: ${passed}/${results.length} passed`,
    ...results.map((r) => `  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ` - ${r.detail}` : ''}`)
  ].join('\n')

  const out = process.env['WC_SELFTEST_OUT'] || join(app.getPath('temp'), 'wc-selftest.txt')
  await fs.writeFile(out, report, 'utf8').catch(() => undefined)
  console.log(report)

  app.exit(passed === results.length ? 0 : 1)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
