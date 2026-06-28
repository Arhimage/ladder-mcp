import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const MAX_PROBE_BODY_BYTES = 256 * 1024

// Read a fetch response body but stop once MAX_PROBE_BODY_BYTES is reached, so a
// misbehaving or hostile local endpoint cannot stream an unbounded body into memory.
// The surrounding AbortController still bounds total time.
export async function readBodyCapped(response: Response): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader()
  if (!reader) {
    // The body is not streamable; still cap the returned text so a non-streaming
    // response cannot return an unbounded body.
    const text = await response.text()
    const bytes = Buffer.byteLength(text, 'utf-8')
    if (bytes > MAX_PROBE_BODY_BYTES) {
      return { text: Buffer.from(text, 'utf-8').subarray(0, MAX_PROBE_BODY_BYTES).toString('utf-8'), truncated: true }
    }
    return { text, truncated: false }
  }
  const decoder = new TextDecoder()
  let text = ''
  let total = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_PROBE_BODY_BYTES) {
      text += decoder.decode(value.slice(0, Math.max(0, MAX_PROBE_BODY_BYTES - (total - value.byteLength))))
      truncated = true
      await reader.cancel()
      break
    }
    text += decoder.decode(value, { stream: true })
  }
  if (!truncated) text += decoder.decode()
  return { text, truncated }
}

export interface DesktopStatus {
  experimental: true
  readOnly: true
  bridgeCommand?: {
    ok: boolean
    stdout?: string
    stderr?: string
    error?: string
  }
  bridgeHttp?: {
    ok: boolean
    status?: number
    body?: unknown
    error?: string
    truncated?: boolean
  }
  safety: string[]
}

export async function getDesktopStatus(): Promise<DesktopStatus> {
  const safety = [
    'Experimental/read-only probe only.',
    'Does not read desktop token-store files.',
    'Does not replay web auth.',
    'Does not submit desktop Work tasks.',
  ]
  const status: DesktopStatus = { experimental: true, readOnly: true, safety }

  try {
    // Resolved from PATH. This is safe by construction: execFile runs the binary
    // directly (no shell, so no metacharacter injection), the only argument is the
    // fixed read-only `status` verb, and a missing binary simply rejects below.
    const { stdout, stderr } = await execFileAsync('kimi-webbridge', ['status'], {
      timeout: 5000,
      windowsHide: true,
    })
    status.bridgeCommand = { ok: true, stdout: String(stdout), stderr: String(stderr) }
  } catch (error) {
    status.bridgeCommand = { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3000)
    try {
      const response = await fetch('http://127.0.0.1:10086/status', { signal: controller.signal })
      const { text, truncated } = await readBodyCapped(response)
      let body: unknown = text
      if (!truncated) {
        try {
          body = JSON.parse(text)
        } catch {
          // Keep raw text.
        }
      }
      status.bridgeHttp = { ok: response.ok, status: response.status, body, ...(truncated ? { truncated: true } : {}) }
    } finally {
      clearTimeout(timer)
    }
  } catch (error) {
    status.bridgeHttp = { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  return status
}

export function buildBudgetProbeGuide(includeCliProbe: boolean): string {
  const lines = [
    '## Kimi Budget Probe (experimental evidence workflow)',
    '',
    'Safety boundaries:',
    '- This probe does not read desktop token-store files.',
    '- This probe does not replay web auth.',
    '- This probe does not submit desktop Work tasks.',
    '- Treat budget separation as unproven until visible counters confirm it.',
    '',
    'Manual evidence steps:',
    '1. Record visible Kimi Code CLI usage/billing counters.',
    '2. Record visible Desktop/OK Computer/Kimi Work counters from the app UI.',
    '3. Run one tiny CLI prompt.',
    '4. Run one tiny Desktop Work task manually in the visible app.',
    '5. Compare which counters moved after refresh.',
    '6. Repeat once to rule out delayed accounting.',
  ]
  if (includeCliProbe) {
    lines.push('', 'CLI probe requested: run a tiny `kimi_chat`/`kimi_analyze` prompt separately and compare visible counters.')
  }
  return lines.join('\n')
}
