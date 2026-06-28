import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { clampTimeout } from './transports/acp.js'
import { buildKimiEnv, resolveKimiPaths } from './environment.js'
import { createProgressCoalescer, createTodoTracker, parseCliTodoSnapshot } from './progress.js'
import type { KimiResult, ProgressReporter } from './types.js'

const MAX_CAPTURE_CHARS = 16 * 1024 * 1024
const MAX_FAILURE_STREAM_CHARS = 2_000

// Append to a captured stream while enforcing a hard ceiling so a runaway CLI cannot
// grow the buffer without bound. Once the cap is reached, further data is dropped (the
// stream is still drained by Node, just not stored).
export function appendCapped(current: string, addition: string, max: number): string {
  if (current.length >= max) return current
  const next = current + addition
  return next.length > max ? next.slice(0, max) : next
}

export interface KimiRunConfig {
  prompt: string
  workDir?: string
  sessionId?: string
  continueLast?: boolean
  timeoutMs?: number
  maxOutputChars?: number
  includeThinking?: boolean
  edit?: boolean
  onProgress?: ProgressReporter
  signal?: AbortSignal
}

export interface ParsedKimiOutput {
  text: string
  sessionId?: string
}

export function buildKimiArgs(config: KimiRunConfig): string[] {
  const args = ['-p', config.prompt, '--output-format', 'stream-json']
  if (config.sessionId) {
    args.push('-S', config.sessionId)
  } else if (config.continueLast) {
    args.push('-C')
  }
  // Kimi CLI 0.20.1 rejects combining --plan with -p/--prompt (non-interactive
  // prompt mode), and the other restriction flags (--auto, -y) are also
  // incompatible. For edit:false / omitted edit we therefore pass no restriction
  // flag and rely on the prompt/system to avoid edits.
  return args
}

const READ_ONLY_GUARD = '[READ-ONLY ANALYSIS MODE] Do not create, modify, or delete any files, directories, or repository state. Only read, analyze, explain, and report.'

// Prepends a read-only guard to the prompt when edit mode is not explicitly
// enabled. Kimi CLI 0.20.1 has no -p-compatible read-only flag, so this is the
// only available enforcement mechanism for the analysis-only contract.
export function applyReadOnlyGuard(prompt: string, edit: boolean | undefined): string {
  if (edit === true) return prompt
  return `${READ_ONLY_GUARD}\n\n${prompt}`
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content.map((part) => {
    if (typeof part === 'string') return part
    if (part && typeof part === 'object') {
      const value = part as Record<string, unknown>
      if (typeof value.text === 'string') return value.text
      if (typeof value.content === 'string') return value.content
      if (typeof value.type === 'string') {
        if (value.type === 'image') return '[image]'
        if (value.type === 'tool_result') return '[tool_result]'
        return `[${value.type}]`
      }
    }
    return '[non-text]'
  }).join('')
}

// The Kimi CLI emits tool calls on `role:assistant` records as a `tool_calls`
// array shaped like OpenAI function calls. Extract a concise "Action target"
// string so CLI runs can surface the current action as an immediate progress
// event, matching the ACP transport behavior.
function extractCliToolTarget(argsJson: string | undefined): string | undefined {
  if (!argsJson) return undefined
  try {
    const parsed = JSON.parse(argsJson) as Record<string, unknown>
    const value = parsed.path ?? parsed.skill ?? parsed.command
    if (typeof value === 'string' && value.trim()) {
      const trimmed = value.trim()
      return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed
    }
  } catch {
    // Ignore malformed argument JSON.
  }
  return undefined
}

function formatCliToolCall(toolCall: unknown): string | undefined {
  if (!toolCall || typeof toolCall !== 'object') return undefined
  const tc = toolCall as Record<string, unknown>
  let name: string | undefined
  let args: string | undefined
  if (tc.function && typeof tc.function === 'object') {
    const fn = tc.function as Record<string, unknown>
    name = typeof fn.name === 'string' ? fn.name : undefined
    args = typeof fn.arguments === 'string' ? fn.arguments : undefined
  } else {
    name = typeof tc.name === 'string' ? tc.name : undefined
    args = typeof tc.arguments === 'string' ? tc.arguments : undefined
  }
  if (!name) return undefined
  const target = extractCliToolTarget(args)
  return target ? `${name} ${target}` : name
}

function extractResumeHint(record: Record<string, unknown>): string | undefined {
  if (record.role !== 'meta') return undefined

  const scan = (obj: Record<string, unknown>): string | undefined => {
    for (const key of ['session_id', 'sessionId', 'id', 'session']) {
      const value = obj[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
    return undefined
  }

  // Primary match: the exact resume-hint marker Kimi emits.
  if (record.type === 'session.resume_hint') {
    const direct = scan(record)
    if (direct) return direct
    if (record.content && typeof record.content === 'object') {
      const nested = scan(record.content as Record<string, unknown>)
      if (nested) return nested
    }
  }

  // Fuzzy fallback: any meta record carrying an id-shaped string, even if the
  // concrete type marker differs (e.g. session.resumeHint, session.created).
  const direct = scan(record)
  if (direct) return direct
  if (record.content && typeof record.content === 'object') {
    return scan(record.content as Record<string, unknown>)
  }
  return undefined
}

export function parseKimiStreamJson(stdout: string): ParsedKimiOutput {
  let lastAssistant = ''
  let sessionId: string | undefined

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line.startsWith('{')) continue

    try {
      const record = JSON.parse(line) as Record<string, unknown>
      if (record.role === 'assistant') {
        const text = contentToText(record.content)
        if (text.trim()) lastAssistant = text
      }
      sessionId = extractResumeHint(record) ?? sessionId
    } catch {
      // Ignore non-JSON status lines.
    }
  }

  return {
    text: lastAssistant.trim() || '(empty response from Kimi)',
    sessionId,
  }
}

export function truncateAtBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const slice = text.slice(0, maxChars)
  const cutPoint = Math.max(slice.lastIndexOf('\n## '), slice.lastIndexOf('\n\n'), Math.floor(maxChars * 0.8))
  return `${slice.slice(0, cutPoint).trimEnd()}\n\n---\nOutput truncated (${text.length.toLocaleString()} chars exceeded ${maxChars.toLocaleString()} char budget). Use kimi_resume with the same session for follow-up questions.`
}

function killProcessTree(pid: number | undefined): void {
  if (!pid) return
  const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
  })
  killer.on('error', () => undefined)
}

const KIMI_DEFAULT_TIMEOUT_MS = 300_000
const KIMI_KILL_GRACE_MS = 2_000

export function runKimi(config: KimiRunConfig): Promise<KimiResult> {
  // Reuse the ACP timeout clamp so 0/NaN/negative values cannot collapse the
  // timeout to an immediate abort. The default matches the historic CLI budget.
  const timeoutMs = clampTimeout(config.timeoutMs, KIMI_DEFAULT_TIMEOUT_MS)
  const maxOutputChars = config.maxOutputChars ?? 60_000
  const paths = resolveKimiPaths()

  if (!paths.binaryPath) {
    return Promise.resolve({
      ok: false,
      text: '',
      error: 'Kimi CLI binary was not found on PATH or at ~/.kimi-code/bin/kimi.exe.',
    })
  }

  if (config.signal?.aborted) {
    return Promise.resolve({
      ok: false,
      text: '',
      error: 'Kimi cancelled',
    })
  }

  const guardedPrompt = applyReadOnlyGuard(config.prompt, config.edit)

  return new Promise((resolve) => {
    let settled = false
    const proc = spawn(paths.binaryPath!, buildKimiArgs({ ...config, prompt: guardedPrompt }), {
      env: buildKimiEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      cwd: config.workDir ? path.resolve(config.workDir) : undefined,
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let streamBuffer = ''
    const coalescer = config.onProgress ? createProgressCoalescer(config.onProgress) : undefined
    const todoTracker = config.onProgress ? createTodoTracker() : undefined

    let onAbort: () => void

    const finish = (result: KimiResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      coalescer?.stop()
      config.signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }

    onAbort = () => {
      killProcessTree(proc.pid)
      finish({ ok: false, text: '', error: 'Kimi cancelled' })
    }
    config.signal?.addEventListener('abort', onAbort, { once: true })
    // Cover the race where the signal is already aborted right after registration.
    if (config.signal?.aborted) {
      onAbort()
      return
    }

    let timer = setTimeout(() => {
      timedOut = true
      killProcessTree(proc.pid)
      // Wait for the process exit (or a short grace) before resolving so callers
      // do not observe the promise settling while the tree is still being killed.
      timer = setTimeout(() => {
        finish({ ok: false, text: '', error: `Kimi timed out after ${Math.round(timeoutMs / 1000)}s` })
      }, KIMI_KILL_GRACE_MS)
    }, timeoutMs)

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendCapped(stdout, chunk.toString('utf-8'), MAX_CAPTURE_CHARS)
      if (!config.onProgress) return
      streamBuffer += chunk.toString('utf-8')
      const lines = streamBuffer.split(/\r?\n/)
      streamBuffer = lines.pop() ?? ''
      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line.startsWith('{')) continue
        try {
          const record = JSON.parse(line) as Record<string, unknown>
          if (record.type === 'plan') {
            const text = contentToText(record.content).trim()
            if (text) coalescer?.add('plan', text)
          } else if (record.role === 'assistant') {
            const text = contentToText(record.content)
            if (text.trim()) coalescer?.add('message', text)

            const toolCalls = record.tool_calls
            if (Array.isArray(toolCalls)) {
              for (const toolCall of toolCalls) {
                const toolText = formatCliToolCall(toolCall)
                if (toolText) coalescer?.add('tool_call', toolText)
              }
            }
          } else if (record.role === 'tool') {
            const text = contentToText(record.content)
            const todos = parseCliTodoSnapshot(text)
            if (todos && todoTracker?.update(todos)) {
              coalescer?.add('todo', todoTracker.getSummary(), { todoFullList: todoTracker.getFullList() })
            }
          }
        } catch {
          // Ignore non-JSON status lines.
        }
      }
    })
    proc.stderr?.on('data', (chunk: Buffer) => {
      // Kimi CLI 0.20.1 does not stream thinking to stderr incrementally during a
      // -p run; stderr is empty until process exit. We therefore do not emit live
      // `thought` progress events here and keep the existing end-of-run capture.
      stderr = appendCapped(stderr, chunk.toString('utf-8'), MAX_CAPTURE_CHARS)
    })

    proc.on('error', (err) => {
      finish({ ok: false, text: '', error: err instanceof Error ? err.message : String(err) })
    })

    proc.on('close', (code) => {
      if (settled) return
      if (timedOut) {
        finish({ ok: false, text: '', error: `Kimi timed out after ${Math.round(timeoutMs / 1000)}s` })
        return
      }
      if (code !== 0) {
        const err = stderr.trim()
        const out = stdout.trim()
        let message: string
        if (err && out) {
          const cappedErr = err.length > MAX_FAILURE_STREAM_CHARS ? `${err.slice(0, MAX_FAILURE_STREAM_CHARS)}…` : err
          const cappedOut = out.length > MAX_FAILURE_STREAM_CHARS ? `${out.slice(0, MAX_FAILURE_STREAM_CHARS)}…` : out
          message = `kimi exited with code ${code}\nstderr: ${cappedErr}\nstdout: ${cappedOut}`
        } else {
          message = err || out || `kimi exited with code ${code}`
        }
        finish({ ok: false, text: '', error: message })
        return
      }

      const parsed = parseKimiStreamJson(stdout)
      const text = truncateAtBoundary(parsed.text, maxOutputChars)
      const thinking = config.includeThinking ? stderr.trim() || undefined : undefined
      finish({ ok: true, text, thinking, sessionId: parsed.sessionId })
    })
  })
}
