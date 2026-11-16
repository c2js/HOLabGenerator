import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { preserveLegacyUserData, SettingsStore } from './settings'

let dir: string
let paths: { userData: string; sessionData: string }

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'holab-settings-'))
  const profile = join(dir, 'Hands On Lab Generator')
  await mkdir(profile)
  paths = { userData: profile, sessionData: profile }
  vi.spyOn(app, 'getPath').mockImplementation((name) => {
    if (name === 'userData' || name === 'sessionData') return paths[name]
    if (name === 'documents') return join(dir, 'Documents')
    return dir
  })
  vi.spyOn(app, 'setPath').mockImplementation((name, path) => {
    if (name === 'userData' || name === 'sessionData') paths[name] = path
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

describe('product rename compatibility', () => {
  it.each([
    { packaged: false, legacyName: 'workshop-capture' },
    { packaged: true, legacyName: 'Workshop Capture' }
  ])('keeps settings and the session profile from $legacyName', async ({ packaged, legacyName }) => {
    vi.spyOn(app, 'isPackaged', 'get').mockReturnValue(packaged)
    const legacy = join(dir, legacyName)
    await mkdir(legacy)
    const saved = {
      projectsDir: join(dir, 'Existing guides'),
      micDeviceId: 'selected-microphone',
      miniBar: { x: 240, y: 300 }
    }
    await writeFile(join(legacy, 'settings.json'), JSON.stringify(saved))

    preserveLegacyUserData()
    const settings = await new SettingsStore().load()

    expect(paths).toEqual({ userData: legacy, sessionData: legacy })
    expect(settings).toMatchObject(saved)
  })

  it('uses the new profile and guides folder on a fresh installation', async () => {
    vi.spyOn(app, 'isPackaged', 'get').mockReturnValue(true)
    const profile = paths.userData

    preserveLegacyUserData()
    const store = new SettingsStore()
    await store.load()

    expect(app.setPath).not.toHaveBeenCalled()
    expect(paths.userData).toBe(profile)
    expect(await store.ensureProjectsDir()).toBe(join(dir, 'Documents', 'Hands On Lab Generator'))
  })
})
