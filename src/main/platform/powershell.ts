import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

const DELIM = '<<<WC-END>>>'

/**
 * A single long-lived PowerShell process we talk to over stdin/stdout.
 *
 * Spawning `powershell.exe` per query costs 300-700ms, which is far too slow to
 * run at snip time. Keeping one process warm brings a query down to a few
 * milliseconds and means we need no native modules at all - everything comes
 * from what Windows already ships.
 */
export class PowerShellBridge {
  private proc: ChildProcessWithoutNullStreams | null = null
  private buffer = ''
  private pending: Array<{ resolve: (v: string) => void; reject: (e: Error) => void }> = []
  private starting: Promise<void> | null = null
  private disposed = false

  constructor(private readonly preamble: string = '') {}

  private async ensureStarted(): Promise<void> {
    if (this.proc || this.disposed) return
    if (this.starting) return this.starting

    this.starting = new Promise<void>((resolve, reject) => {
      let proc: ChildProcessWithoutNullStreams
      try {
        proc = spawn(
          'powershell.exe',
          ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
          { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
        )
      } catch (err) {
        reject(err as Error)
        return
      }

      proc.stdout.setEncoding('utf8')
      proc.stdout.on('data', (chunk: string) => this.onData(chunk))
      proc.on('error', (err) => {
        this.failAll(err)
        this.proc = null
      })
      proc.on('exit', () => {
        this.failAll(new Error('PowerShell helper exited'))
        this.proc = null
      })

      this.proc = proc
      if (this.preamble.trim()) {
        // Errors in the preamble must not poison the first real query.
        proc.stdin.write(`try { ${this.preamble} } catch { }\n`)
      }
      resolve()
    }).finally(() => {
      this.starting = null
    })

    return this.starting
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let idx: number
    while ((idx = this.buffer.indexOf(DELIM)) !== -1) {
      const payload = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + DELIM.length)
      const waiter = this.pending.shift()
      waiter?.resolve(payload.trim())
    }
  }

  private failAll(err: Error): void {
    const waiters = this.pending
    this.pending = []
    for (const w of waiters) w.reject(err)
  }

  /** Run a one-line PowerShell expression and return its stdout. */
  async run(command: string, timeoutMs = 2000): Promise<string> {
    if (this.disposed) throw new Error('PowerShell bridge disposed')
    await this.ensureStarted()
    const proc = this.proc
    if (!proc) throw new Error('PowerShell unavailable')

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.pending.findIndex((p) => p.resolve === wrappedResolve)
        if (i !== -1) this.pending.splice(i, 1)
        reject(new Error('PowerShell query timed out'))
      }, timeoutMs)

      const wrappedResolve = (v: string): void => {
        clearTimeout(timer)
        resolve(v)
      }
      const wrappedReject = (e: Error): void => {
        clearTimeout(timer)
        reject(e)
      }

      this.pending.push({ resolve: wrappedResolve, reject: wrappedReject })
      proc.stdin.write(`try { ${command} } catch { }\n; Write-Output '${DELIM}'\n`)
    })
  }

  dispose(): void {
    this.disposed = true
    this.failAll(new Error('disposed'))
    try {
      this.proc?.stdin.end()
      this.proc?.kill()
    } catch {
      /* already gone */
    }
    this.proc = null
  }
}
