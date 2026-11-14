import { join } from 'node:path'
import { homedir } from 'node:os'
import { shell } from 'electron'
import type { CaptureContext } from '@shared/types'
import type { PlatformAdapter } from './types'
import { PowerShellBridge } from './powershell'

/**
 * Defines a tiny Win32 interop type once, in the warm PowerShell process, so
 * every later foreground-window query is just a method call.
 */
const PREAMBLE = `
if (-not ('WCWin' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WCWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
  public static uint Seq() { return GetClipboardSequenceNumber(); }
  public static string Title() {
    IntPtr h = GetForegroundWindow();
    StringBuilder sb = new StringBuilder(1024);
    GetWindowTextW(h, sb, sb.Capacity);
    return sb.ToString();
  }
  public static int Pid() {
    IntPtr h = GetForegroundWindow();
    int pid = 0; GetWindowThreadProcessId(h, out pid); return pid;
  }
}
'@
}
`.trim()

const QUERY = `
$t = [WCWin]::Title()
$p = [WCWin]::Pid()
$n = (Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName
[Console]::Out.Write((ConvertTo-Json -Compress ([pscustomobject]@{ title = $t; process = $n })))
[Console]::Out.Write("\`n")
`.trim()

const SEQ_QUERY = `[Console]::Out.Write([string][WCWin]::Seq()); [Console]::Out.Write("\`n")`

export class Win32Adapter implements PlatformAdapter {
  readonly id: NodeJS.Platform = 'win32'
  readonly snipToolName = 'Snipping Tool'

  private ps: PowerShellBridge | null = null

  /** Where Win+PrtScn and Snipping Tool's auto-save option put files. */
  screenshotsDir(): string {
    return join(homedir(), 'Pictures', 'Screenshots')
  }

  /**
   * `ms-screenclip:` is exactly what the Win+Shift+S hotkey invokes, so the
   * author gets the native region selector *and* the native annotation editor
   * (pen, highlighter, shapes, text, blur) with no code from us.
   */
  async triggerSnip(): Promise<void> {
    await shell.openExternal('ms-screenclip:')
  }

  async activeWindow(): Promise<CaptureContext> {
    try {
      this.ps ??= new PowerShellBridge(PREAMBLE)
      const out = await this.ps.run(QUERY)
      const line = out.split('\n').find((l) => l.trim().startsWith('{'))
      if (!line) return {}
      const parsed = JSON.parse(line) as { title?: string; process?: string }
      return {
        windowTitle: parsed.title?.trim() || undefined,
        processName: parsed.process?.trim() || undefined
      }
    } catch {
      // Context is a nice-to-have; never let it break a capture.
      return {}
    }
  }

  /**
   * Win32 hands us a clipboard change counter for free. Polling that is far
   * cheaper than re-encoding a 4K screenshot to PNG several times a second just
   * to notice that nothing has changed yet.
   */
  async clipboardSequence(): Promise<number | null> {
    try {
      this.ps ??= new PowerShellBridge(PREAMBLE)
      const out = await this.ps.run(SEQ_QUERY, 1500)
      const line = out.split('\n').map((l) => l.trim()).find((l) => /^\d+$/.test(l))
      return line ? Number(line) : null
    } catch {
      return null
    }
  }

  dispose(): void {
    this.ps?.dispose()
    this.ps = null
  }
}
