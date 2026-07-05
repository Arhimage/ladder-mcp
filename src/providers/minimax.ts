import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { truncateAtBoundary } from '../response.js'
import type { AgentAskOptions, AgentResult, ToolUseBlock } from './types.js'

const DEFAULT_MMX_TIMEOUT_MS = 120_000
const MMX_MAX_BUFFER_BYTES = 16 * 1024 * 1024

export type MmxEnvironment = NodeJS.ProcessEnv

export interface MmxStatus {
  installed: boolean
  binPath?: string
  version?: string
  authenticated: boolean
  error?: string
}

export interface MmxAuthStatus {
  authenticated: boolean
  username?: string
  error?: string
}

const MMX_BIN_NAMES = ['mmx.exe', 'mmx.cmd']

function splitWindowsPath(pathValue: string | undefined): string[] {
  return (pathValue ?? '').split(';').map((part) => part.trim()).filter(Boolean)
}

export function findMmxOnPath(
  env?: MmxEnvironment,
  existsSync: (candidate: string) => boolean = fs.existsSync,
): string | undefined {
  const pathValue = env?.PATH ?? env?.Path ?? process.env.PATH ?? process.env.Path
  for (const entry of splitWindowsPath(pathValue)) {
    for (const name of MMX_BIN_NAMES) {
      const candidate = path.join(entry, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

function resolveMmxShim(
  binaryPath: string,
  existsSync: (candidate: string) => boolean = fs.existsSync,
): { node: string; script: string } | undefined {
  const baseDir = path.dirname(binaryPath)
  const script = path.join(baseDir, 'node_modules', 'mmx-cli', 'dist', 'mmx.mjs')
  if (!existsSync(script)) return undefined
  const localNode = path.join(baseDir, 'node.exe')
  return { node: existsSync(localNode) ? localNode : 'node', script }
}

function buildMmxCommand(
  binaryPath: string,
  args: string[],
  existsSync?: (candidate: string) => boolean,
): { file: string; args: string[] } {
  const lower = binaryPath.toLowerCase()
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    const target = resolveMmxShim(binaryPath, existsSync)
    if (!target) {
      throw new Error(
        `MiniMax .cmd shim at ${binaryPath} does not resolve to node_modules/mmx-cli/dist/mmx.mjs.`,
      )
    }
    return { file: target.node, args: [target.script, ...args] }
  }
  return { file: binaryPath, args }
}

export function runMmxCommand(
  binaryPath: string,
  args: string[],
  options: {
    env?: MmxEnvironment
    timeout?: number
    existsSync?: (candidate: string) => boolean
    signal?: AbortSignal
  },
): Promise<{ stdout: string; stderr: string }> {
  const { file, args: spawnedArgs } = buildMmxCommand(binaryPath, args, options.existsSync)
  return new Promise((resolve, reject) => {
    let abortListener: (() => void) | undefined
    const cleanup = () => {
      if (abortListener && options.signal) {
        options.signal.removeEventListener('abort', abortListener)
      }
    }

    const child = execFile(
      file,
      spawnedArgs,
      {
        env: options.env,
        timeout: options.timeout,
        windowsHide: true,
        maxBuffer: MMX_MAX_BUFFER_BYTES,
      },
      (error, stdout, stderr) => {
        cleanup()
        if (error) {
          reject(error)
          return
        }
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      },
    )

    if (options.signal) {
      if (options.signal.aborted) {
        child.kill()
        cleanup()
        reject(new Error('MiniMax command was aborted before start.'))
        return
      }
      abortListener = () => {
        child.kill()
      }
      options.signal.addEventListener('abort', abortListener, { once: true })
    }
  })
}

export async function getMmxVersion(
  binaryPath: string,
  existsSync?: (candidate: string) => boolean,
): Promise<string | undefined> {
  try {
    const { stdout } = await runMmxCommand(binaryPath, ['--version'], { timeout: 5_000, existsSync })
    return stdout.trim() || undefined
  } catch {
    return undefined
  }
}

function maskSecrets(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value
  const record = value as Record<string, unknown>
  const masked: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(record)) {
    const lower = key.toLowerCase()
    if (
      lower.includes('key') ||
      lower.includes('token') ||
      lower.includes('secret') ||
      lower.includes('password') ||
      lower.includes('credential')
    ) {
      masked[key] = typeof val === 'string' && val.length > 0 ? '***' : val
    } else {
      masked[key] = val
    }
  }
  return masked
}

export async function getMmxAuthStatus(
  binaryPath: string,
  existsSync?: (candidate: string) => boolean,
): Promise<MmxAuthStatus> {
  try {
    const { stdout } = await runMmxCommand(
      binaryPath,
      ['auth', 'status', '--output', 'json', '--non-interactive', '--no-color'],
      { timeout: 10_000, existsSync },
    )
    const data = JSON.parse(stdout) as Record<string, unknown>
    // Infer authentication from the raw, unmasked response so that shapes such
    // as { method: 'api-key', source: 'config.json', key: '...' } are recognised.
    const explicit = typeof data.authenticated === 'boolean' ? data.authenticated : undefined
    const inferred =
      explicit ??
      Boolean(
        data.method === 'api-key' ||
          data.method === 'api_key' ||
          (typeof data.key === 'string' && data.key.length > 0) ||
          data.user ||
          data.username ||
          data.email ||
          data.account ||
          data.token ||
          data.access_token ||
          data.refresh_token ||
          data.id_token ||
          (data.status && data.status !== 'unauthenticated'),
      )
    // Build the returned object from safe fields only; secrets are masked for
    // defence-in-depth before being returned or logged.
    const safe = maskSecrets(data) as Record<string, unknown>
    return {
      authenticated: inferred,
      username: typeof data.user === 'string' ? data.user : typeof data.username === 'string' ? data.username : undefined,
      ...(safe.error ? { error: String(safe.error) } : {}),
    }
  } catch (error) {
    return {
      authenticated: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function getMinimaxStatus(
  env?: MmxEnvironment,
  existsSync?: (candidate: string) => boolean,
): Promise<MmxStatus> {
  const binPath = findMmxOnPath(env, existsSync)
  if (!binPath) {
    return {
      installed: false,
      authenticated: false,
      error: 'MiniMax CLI (mmx) was not found on PATH.',
    }
  }

  const [version, auth] = await Promise.all([
    getMmxVersion(binPath, existsSync),
    getMmxAuthStatus(binPath, existsSync),
  ])

  let error: string | undefined
  if (!version) {
    error = 'MiniMax CLI (mmx) was found but its version could not be detected.'
  } else if (!auth.authenticated) {
    error = auth.error ?? 'MiniMax CLI (mmx) is not authenticated. Run: mmx login'
  }

  return {
    installed: true,
    binPath,
    version,
    authenticated: auth.authenticated,
    error,
  }
}

function buildMmxPrompt(options: AgentAskOptions): string {
  if (options.context) {
    const focus = options.prompt.trim() || 'Independently verify correctness. Surface bugs, edge cases, security issues, and concrete improvements.'
    const role = options.role?.trim() || 'You are a meticulous, independent senior engineer. Be skeptical, specific, and actionable.'
    return `${role}\n\n## Your task\n${focus}\n\n## Material to verify\n${options.context}`
  }
  if (options.role) {
    return `${options.role}\n\n${options.prompt}`
  }
  return options.prompt
}

export function parseMmxChatResponse(raw: string, maxOutputChars?: number): AgentResult {
  let data: Record<string, unknown>
  try {
    data = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return { ok: false, text: '', error: 'MiniMax response is not valid JSON.' }
  }

  const textParts: string[] = []
  const thinkingParts: string[] = []
  const toolUses: ToolUseBlock[] = []

  const content = Array.isArray(data.content) ? data.content : []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const record = block as Record<string, unknown>
    switch (record.type) {
      case 'text': {
        if (typeof record.text === 'string') textParts.push(record.text)
        break
      }
      case 'thinking': {
        if (typeof record.thinking === 'string') thinkingParts.push(record.thinking)
        break
      }
      case 'tool_use': {
        if (typeof record.id === 'string' && typeof record.name === 'string') {
          toolUses.push({ id: record.id, name: record.name, input: record.input })
        }
        break
      }
    }
  }

  let text = textParts.join('\n\n').trim()
  const thinking = thinkingParts.join('\n\n').trim() || undefined

  if (maxOutputChars !== undefined && text.length > maxOutputChars) {
    text = truncateAtBoundary(text, maxOutputChars)
  }

  return {
    ok: true,
    text,
    thinking,
    toolUses: toolUses.length > 0 ? toolUses : undefined,
  }
}

export async function runMinimaxAsk(
  options?: AgentAskOptions & {
    env?: MmxEnvironment
    existsSync?: (candidate: string) => boolean
  },
): Promise<AgentResult> {
  const opts = options ?? { prompt: '' }
  const binaryPath = findMmxOnPath(opts.env, opts.existsSync)
  if (!binaryPath) {
    return {
      ok: false,
      text: '',
      error: 'MiniMax CLI (mmx) was not found on PATH. Install mmx and ensure it is on PATH.',
    }
  }

  const prompt = buildMmxPrompt(opts)
  const timeoutMs =
    typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? opts.timeoutMs
      : DEFAULT_MMX_TIMEOUT_MS
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000))

  const args = [
    'text',
    'chat',
    '--message',
    prompt,
    '--output',
    'json',
    '--non-interactive',
    '--no-color',
    '--timeout',
    String(timeoutSeconds),
  ]

  try {
    const { stdout } = await runMmxCommand(binaryPath, args, {
      env: opts.env,
      timeout: timeoutMs + 10_000,
      existsSync: opts.existsSync,
    })
    const result = parseMmxChatResponse(stdout, opts.maxOutputChars)
    if (result.ok && result.text === '' && !result.toolUses) {
      return { ok: false, text: '', error: 'MiniMax returned an empty answer.' }
    }
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/timed out/i.test(message)) {
      return { ok: false, text: '', error: `MiniMax request timed out after ${Math.round(timeoutMs / 1000)}s` }
    }
    return { ok: false, text: '', error: `MiniMax request failed: ${message}` }
  }
}
