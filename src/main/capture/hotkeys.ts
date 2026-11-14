import { globalShortcut } from 'electron'

export interface HotkeyActions {
  toggleDictation: () => void | Promise<void>
  snip: () => void | Promise<void>
  scratch: () => void | Promise<void>
  sectionBreak: () => void | Promise<void>
  clipboard: () => void | Promise<void>
  toggleCompact: () => void | Promise<void>
}

export interface HotkeyBinding {
  accelerator: string
  label: string
  description: string
  action: keyof HotkeyActions
}

/**
 * Ctrl+Alt is used on both platforms deliberately: the author is switching
 * between our app and whatever they are demonstrating, and a single muscle
 * memory across machines matters more than platform convention here.
 */
export const BINDINGS: HotkeyBinding[] = [
  {
    accelerator: 'Control+Alt+D',
    label: 'Ctrl+Alt+D',
    description: 'Start or pause dictation',
    action: 'toggleDictation'
  },
  {
    accelerator: 'Control+Alt+S',
    label: 'Ctrl+Alt+S',
    description: 'Snip a screenshot',
    action: 'snip'
  },
  {
    accelerator: 'Control+Alt+Z',
    label: 'Ctrl+Alt+Z',
    description: 'Scratch that - drop the last step',
    action: 'scratch'
  },
  {
    accelerator: 'Control+Alt+B',
    label: 'Ctrl+Alt+B',
    description: 'Insert a section break',
    action: 'sectionBreak'
  },
  {
    accelerator: 'Control+Alt+C',
    label: 'Ctrl+Alt+C',
    description: 'Capture the clipboard as a code block',
    action: 'clipboard'
  },
  {
    accelerator: 'Control+Alt+M',
    label: 'Ctrl+Alt+M',
    description: 'Toggle the compact control bar',
    action: 'toggleCompact'
  }
]

export interface HotkeyRegistration {
  registered: HotkeyBinding[]
  failed: HotkeyBinding[]
  unregister: () => void
}

/**
 * Register the global hotkeys.
 *
 * Failures are reported rather than thrown: another app may already own one of
 * these combinations, and the author needs to be told which one is dead instead
 * of silently losing takes.
 */
export function registerHotkeys(actions: HotkeyActions): HotkeyRegistration {
  const registered: HotkeyBinding[] = []
  const failed: HotkeyBinding[] = []

  for (const binding of BINDINGS) {
    const ok = globalShortcut.register(binding.accelerator, () => {
      void Promise.resolve(actions[binding.action]()).catch((err: unknown) => {
        console.error(`[hotkey] ${binding.accelerator} failed`, err)
      })
    })
    if (ok) registered.push(binding)
    else failed.push(binding)
  }

  return {
    registered,
    failed,
    unregister: () => {
      for (const binding of registered) globalShortcut.unregister(binding.accelerator)
    }
  }
}
