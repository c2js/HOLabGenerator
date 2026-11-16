import { existsSync, promises as fs } from 'node:fs'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { app } from 'electron'

/**
 * App-level preferences, separate from any project.
 *
 * Kept in userData rather than next to the app so an update never wipes them,
 * and written as readable JSON so a user can fix a bad value by hand.
 */
export interface AppSettings {
  /** Where new `.guide` projects are created. */
  projectsDir: string
  /** Show the floating control bar while a project is open. */
  showMiniBar: boolean
  /** Hide the main window and work from the control bar alone. */
  compact: boolean
  /** Drop straight into compact mode once a new guide is created. */
  compactOnCreate: boolean
  /** Chosen microphone id, or empty for the system default. */
  micDeviceId: string
  /** Remembered control bar position, so it stays where the author parked it. */
  miniBar?: { x: number; y: number }
}

/** Keep settings, microphone permissions and local models after the product rename. */
export function preserveLegacyUserData(): void {
  const legacy = join(app.getPath('appData'), app.isPackaged ? 'Workshop Capture' : 'workshop-capture')
  if (existsSync(legacy)) {
    app.setPath('userData', legacy)
    app.setPath('sessionData', legacy)
  }
}

function defaults(): AppSettings {
  return {
    projectsDir: join(app.getPath('documents'), 'Hands On Lab Generator'),
    showMiniBar: true,
    compact: false,
    compactOnCreate: true,
    micDeviceId: ''
  }
}

export class SettingsStore extends EventEmitter {
  private settings: AppSettings = defaults()
  private file = ''
  private saveTimer: NodeJS.Timeout | null = null

  async load(): Promise<AppSettings> {
    this.file = join(app.getPath('userData'), 'settings.json')
    try {
      const raw = await fs.readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Partial<AppSettings>
      this.settings = { ...defaults(), ...parsed }
      // A folder that has since been deleted or moved must not brick "New guide".
      if (typeof this.settings.projectsDir !== 'string' || !this.settings.projectsDir.trim()) {
        this.settings.projectsDir = defaults().projectsDir
      }
    } catch {
      this.settings = defaults()
    }
    return this.settings
  }

  get current(): AppSettings {
    return this.settings
  }

  update(patch: Partial<AppSettings>): AppSettings {
    this.settings = { ...this.settings, ...patch }
    this.emit('changed', this.settings)
    this.scheduleSave()
    return this.settings
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    // Dragging the control bar fires constantly; do not write on every pixel.
    this.saveTimer = setTimeout(() => void this.flush(), 400)
  }

  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (!this.file) return
    try {
      await fs.writeFile(this.file, JSON.stringify(this.settings, null, 2), 'utf8')
    } catch {
      // Preferences are a convenience; never let a failed write break the app.
    }
  }

  /** Create the projects folder if needed, falling back to the default if it cannot be made. */
  async ensureProjectsDir(): Promise<string> {
    try {
      await fs.mkdir(this.settings.projectsDir, { recursive: true })
      return this.settings.projectsDir
    } catch {
      const fallback = defaults().projectsDir
      await fs.mkdir(fallback, { recursive: true })
      this.update({ projectsDir: fallback })
      return fallback
    }
  }
}
