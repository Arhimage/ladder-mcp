import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'
import { buildKimiEnv, resolveKimiPaths } from '../environment.js'
import { VERSION } from '../version.js'
import { createProgressCoalescer, createStallWatchdog, createTodoTracker, parseAcpTodoPayload } from '../progress.js'
import type { KimiResult, ProgressReporter } from '../types.js'

const MAX_ACP_FRAME_BYTES = 8 * 1024 * 1024
const MAX_ACP_HEADER_BYTES = 16 * 1024
const MAX_ACP_METADATA_BYTES = 100 * 1024
const MAX_ACP_UPDATE_CHUNKS = 10_000
export const ACP_TIMEOUT_FLOOR_MS = 1_800_000
const CONTENT_LENGTH_PREFIX_BYTES = 'Content-Length:'.length
const OUTBOUND_ID_SPACE_START = 1_000_000
const MAX_FS_READ_BYTES = 8 * 1024 * 1024
const JSONRPC_INVALID_PARAMS = -32602
const JSONRPC_METHOD_NOT_FOUND = -32601
const JSONRPC_INTERNAL_ERROR = -32603

class AcpError extends Error {
  constructor(message: string, readonly code: number) {
    super(message)
  }
}

// Coerce an untrusted timeout into a usable positive duration. A zero/negative/NaN
// value would otherwise make setTimeout fire (effectively) immediately and abort the
// request before the peer can reply; fall back to a sane default in that case.
export function clampTimeout(ms: number | undefined, fallback: number): number {
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : fallback
}

export function resolveAcpTimeout(timeoutMs?: number): number {
  return timeoutMs === undefined ? ACP_TIMEOUT_FLOOR_MS : Math.max(ACP_TIMEOUT_FLOOR_MS, timeoutMs)
}

// Locate the end of a header block, accepting both the canonical CRLF terminator
// (`\r\n\r\n`) and a lenient LF-only terminator (`\n\n`). Returns the index of the
// terminator and its byte length so the body offset can be computed correctly.
// Without LF support, an LF-only `Content-Length` frame would buffer until the
// header-size guard throws and tears down the whole client.
function findHeaderEnd(buffer: Buffer): { end: number; sep: number } | undefined {
  const crlf = buffer.indexOf('\r\n\r\n')
  const lf = buffer.indexOf('\n\n')
  if (crlf < 0 && lf < 0) return undefined
  if (crlf < 0) return { end: lf, sep: 2 }
  if (lf < 0) return { end: crlf, sep: 4 }
  return crlf <= lf ? { end: crlf, sep: 4 } : { end: lf, sep: 2 }
}

export interface JsonRpcMessage {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

export interface AcpPromptOptions {
  prompt: string
  workDir?: string
  sessionId?: string
  sessionMode?: 'new' | 'load' | 'resume'
  timeoutMs?: number
  signal?: AbortSignal
  onProgress?: ProgressReporter
  includeThinking?: boolean
}

export function encodeAcpMessage(message: JsonRpcMessage): Buffer {
  return Buffer.from(`${JSON.stringify(message)}\n`, 'utf-8')
}

export class AcpMessageParser {
  private buffer = Buffer.alloc(0)
  private recovered: JsonRpcMessage[] = []

  // Messages that were parsed successfully before `push` threw on a malformed frame.
  // The caller drains these so valid frames batched in the same chunk as a bad one
  // are still delivered before the connection is torn down.
  takeRecovered(): JsonRpcMessage[] {
    const recovered = this.recovered
    this.recovered = []
    return recovered
  }

  push(chunk: Buffer | string): JsonRpcMessage[] {
    this.buffer = Buffer.concat([this.buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
    const messages: JsonRpcMessage[] = []

    try {
      return this.parseFrames(messages)
    } catch (error) {
      // Stash whatever parsed cleanly before the malformed frame so the caller can
      // dispatch it; then rethrow to preserve the existing throw-on-malformed contract.
      this.recovered = messages
      throw error
    }
  }

  private parseFrames(messages: JsonRpcMessage[]): JsonRpcMessage[] {
    while (this.buffer.length > 0) {
      const headerTerminator = findHeaderEnd(this.buffer)
      if (headerTerminator) {
        const { end: headerEnd, sep } = headerTerminator
        const header = this.buffer.slice(0, headerEnd).toString('ascii')
        const lengthMatch = header.match(/^Content-Length:\s*(\d+)\s*$/im)
        if (lengthMatch) {
          const bodyLength = Number(lengthMatch[1])
          if (!Number.isSafeInteger(bodyLength) || bodyLength < 0 || bodyLength > MAX_ACP_FRAME_BYTES || String(bodyLength) !== lengthMatch[1]) {
            throw new Error(`Invalid ACP frame length: ${lengthMatch[1]}`)
          }
          const bodyStart = headerEnd + sep
          const bodyEnd = bodyStart + bodyLength
          if (this.buffer.length < bodyEnd) break
          if (bodyLength > 0) {
            messages.push(parseJsonRpcMessage(this.buffer.slice(bodyStart, bodyEnd).toString('utf-8')))
          }
          this.buffer = this.buffer.slice(bodyEnd)
          continue
        }
        // Not a valid Content-Length header block; fall through to newline handling up to the blank line.
        const lineEnd = this.buffer.indexOf('\n')
        if (lineEnd < 0) break
        const line = this.buffer.slice(0, lineEnd).toString('utf-8').trim()
        this.buffer = this.buffer.slice(lineEnd + 1)
        if (line.startsWith('{')) {
          const message = parseJsonRpcLine(line)
          if (message) messages.push(message)
        }
        continue
      }

      const firstCrlf = this.buffer.indexOf('\r\n')
      const looksLikeHeader = firstCrlf >= 0 && this.buffer.slice(0, firstCrlf).toString('ascii').match(/^Content-Length:/i)
      // Only inspect the header-name prefix, not the whole (possibly multi-MB) buffer,
      // to avoid O(n^2) re-encoding while a frame streams in many small chunks.
      const partialHeader = this.buffer.slice(0, CONTENT_LENGTH_PREFIX_BYTES).toString('ascii').match(/^Content-Length:/i)
      if (looksLikeHeader || partialHeader) {
        if (this.buffer.length > MAX_ACP_HEADER_BYTES) throw new Error('ACP frame header is too large.')
        break
      }

      if (this.buffer.length > MAX_ACP_FRAME_BYTES) {
        throw new Error('ACP newline frame is too large.')
      }

      const newline = this.buffer.indexOf('\n')
      if (newline < 0) break
      const line = this.buffer.slice(0, newline).toString('utf-8').trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line.startsWith('{')) {
        const message = parseJsonRpcLine(line)
        if (message) messages.push(message)
      }
    }

    return messages
  }
}

function parseJsonRpcMessage(payload: string): JsonRpcMessage {
  const message = parseJsonRpcObject(payload)
  if (message.jsonrpc !== '2.0') {
    throw new Error('payload is not a JSON-RPC 2.0 message')
  }
  return message
}

function parseJsonRpcLine(payload: string): JsonRpcMessage | undefined {
  const message = parseJsonRpcObject(payload)
  // Newline-delimited fallback frames must also declare JSON-RPC 2.0. Rather than
  // tearing down the parser on a malformed line, ignore the frame; the caller sees
  // it dropped silently, matching the existing lenient newline-path behavior.
  if (message.jsonrpc !== '2.0') return undefined
  return message
}

function parseJsonRpcObject(payload: string): JsonRpcMessage {
  try {
    if (payload.length === 0) {
      throw new Error('empty ACP frame body')
    }
    const message = JSON.parse(payload) as unknown
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new Error('payload is not a JSON-RPC object')
    }
    return message as JsonRpcMessage
  } catch (error) {
    throw new Error(`Malformed ACP JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const MAX_EXTRACT_DEPTH = 20

function extractTextDeep(value: unknown, depth = 0): string[] {
  if (typeof value === 'string') return [value]
  if (!value || typeof value !== 'object') return []
  if (depth > MAX_EXTRACT_DEPTH) return []
  if (Array.isArray(value)) return value.flatMap((item) => extractTextDeep(item, depth + 1))
  const record = value as Record<string, unknown>
  const direct = ['text', 'delta']
    .map((key) => record[key])
    .filter((item): item is string => typeof item === 'string')
  const nested = ['content', 'message', 'update', 'updates', 'result']
    .flatMap((key) => extractTextDeep(record[key], depth + 1))
  return [...direct, ...nested]
}

export function extractAcpText(value: unknown): string {
  // Concatenate text fragments as-is. Kimi streams the answer as many small
  // agent_message_chunk tokens (e.g. "Two", " plus", " two"); trimming each
  // fragment or joining on newlines would drop the spaces between tokens and
  // run words together. Callers trim the final assembled string.
  return extractTextDeep(value).join('')
}

// Keep the trailing portion of `text` within a UTF-8 *byte* budget. Slicing by
// String length (UTF-16 code units) under-counts multibyte characters, so the
// result could still exceed `maxBytes` and could split a surrogate pair, corrupting
// the leading character. This trims on a valid UTF-8 character boundary.
export function truncateUtf8Tail(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf-8')
  if (buf.length <= maxBytes) return text
  let start = buf.length - maxBytes
  // Advance past any UTF-8 continuation byte (0b10xxxxxx) so we start on a char boundary.
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
  return buf.subarray(start).toString('utf-8')
}

function killProcessTree(pid: number | undefined): void {
  if (!pid) return
  try {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    // `spawn` can return undefined in test mocks or if taskkill is missing.
    killer?.on('error', () => undefined)
  } catch {
    // Best-effort cleanup; do not let a kill failure mask the original result.
  }
}

export class AcpClient extends EventEmitter {
  private proc?: ChildProcessWithoutNullStreams
  private parser = new AcpMessageParser()
  private nextId = OUTBOUND_ID_SPACE_START
  private pending = new Map<number | string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  private updates: string[] = []
  private thoughts: string[] = []
  private readonly timeoutMs: number
  private canonicalRoot?: string
  private closing = false
  private resolveClosed?: () => void
  workDir?: string
  readonly closed: Promise<void>

  constructor(timeoutMs = ACP_TIMEOUT_FLOOR_MS) {
    super()
    this.timeoutMs = clampTimeout(timeoutMs, ACP_TIMEOUT_FLOOR_MS)
    this.closed = new Promise<void>((resolve) => {
      this.resolveClosed = resolve
    })
  }

  start(): void {
    if (this.proc) return
    if (this.closing) throw new Error('ACP client is closing')
    const binary = resolveKimiPaths().binaryPath
    if (!binary) throw new Error('Kimi CLI binary was not found on PATH or at ~/.kimi-code/bin/kimi.exe.')

    this.proc = spawn(binary, ['acp'], {
      env: buildKimiEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.proc.stdout.on('data', (chunk) => this.handleMessages(chunk))
    this.proc.stderr.on('data', (chunk) => this.emit('stderr', chunk.toString('utf-8')))
    this.proc.on('error', (error) => this.rejectAll(error))
    this.proc.on('close', (code) => {
      this.resolveClosed?.()
      this.rejectAll(new Error(`kimi acp exited with code ${code}`))
    })
  }

  async request(method: string, params?: unknown, timeoutMs = this.timeoutMs): Promise<unknown> {
    this.start()
    const id = this.nextId++
    const effectiveTimeout = clampTimeout(timeoutMs, this.timeoutMs)
    const message: JsonRpcMessage = { jsonrpc: '2.0', id, method, params }
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`ACP request timed out: ${method}`))
      }, effectiveTimeout)
      this.pending.set(id, { resolve, reject, timer })
    })
    this.proc!.stdin.write(encodeAcpMessage(message), (error) => {
      if (error) this.rejectPending(id, error instanceof Error ? error : new Error(String(error)))
    })
    return promise
  }

  async initialize(): Promise<unknown> {
    return this.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'ladder-mcp', version: VERSION },
      capabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
        permissions: {
          requestPermission: true,
        },
      },
    }, 30_000)
  }

  listSessions(): Promise<unknown> {
    return this.request('session/list', {})
  }

  newSession(workDir?: string): Promise<unknown> {
    this.workDir = workDir
    this.canonicalRoot = undefined
    return this.request('session/new', { cwd: workDir ?? process.cwd(), mcpServers: [] })
  }

  loadSession(sessionId: string): Promise<unknown> {
    return this.request('session/load', { sessionId })
  }

  resumeSession(sessionId: string): Promise<unknown> {
    return this.request('session/resume', { sessionId })
  }

  prompt(sessionId: string | undefined, prompt: string, workDir?: string): Promise<unknown> {
    return this.request('session/prompt', {
      sessionId,
      cwd: workDir,
      prompt: [{ type: 'text', text: prompt }],
      text: prompt,
    }, this.timeoutMs)
  }

  cancel(sessionId: string): Promise<unknown> {
    return this.request('session/cancel', { sessionId }, 30_000)
  }

  getUpdateText(): string {
    return this.updates.join('').trim()
  }

  getThinkingText(): string {
    return this.thoughts.join('').trim()
  }

  close(): void {
    if (this.closing) return
    this.closing = true
    if (this.proc) killProcessTree(this.proc.pid)
  }

  private handleMessages(chunk: Buffer): void {
    let messages: JsonRpcMessage[]
    try {
      messages = this.parser.push(chunk)
    } catch (error) {
      // Deliver any valid frames that parsed before the malformed one, then tear down.
      // Without this, a single bad frame would discard legitimate responses batched in
      // the same chunk and reject every pending request.
      this.dispatch(this.parser.takeRecovered())
      this.rejectAll(error instanceof Error ? error : new Error(String(error)))
      this.close()
      return
    }

    this.dispatch(messages)
  }

  private dispatch(messages: JsonRpcMessage[]): void {
    for (const message of messages) {
      if (message.id !== undefined) {
        if (message.method !== undefined) {
          // Inbound JSON-RPC request from the agent: handle and write a response back.
          void this.handleRequest(message)
          continue
        }

        // Look up by the raw id (number or string). Coercing to Number turned every
        // non-numeric id into NaN, so string/UUID response ids never matched their
        // pending request. Our own requests use numeric ids in the outbound id space,
        // so this is exact and never collides with agent request ids.
        const pending = this.pending.get(message.id)
        if (!pending) continue
        const id = message.id
        this.pending.delete(id)
        clearTimeout(pending.timer)
        if (message.error) {
          const details = message.error.data ? `: ${JSON.stringify(message.error.data)}` : ''
          pending.reject(new Error(`${message.error.message ?? 'ACP request failed'}${details}`))
        }
        else pending.resolve(message.result)
        continue
      }

      if (message.method === 'session/update') {
        const params = message.params as { update?: { sessionUpdate?: string; content?: unknown } } | undefined
        const updateType = params?.update?.sessionUpdate
        // Surface text from message chunks; tool_call / tool_call_update / plan
        // variants are emitted as notifications below so callers can wire them to progress
        // reporters (Story 5.4) without polluting the assembled response text.
        if (updateType === 'agent_message_chunk') {
          const text = extractAcpText(params?.update?.content)
          if (text) {
            this.updates.push(text)
            // Bound retained streamed chunks so a very long session cannot grow the
            // array without limit; drop oldest chunks past the cap.
            if (this.updates.length > MAX_ACP_UPDATE_CHUNKS) {
              this.updates.splice(0, this.updates.length - MAX_ACP_UPDATE_CHUNKS)
            }
          }
        }
        if (updateType === 'agent_thought_chunk') {
          const text = extractAcpText(params?.update?.content)
          if (text) {
            this.thoughts.push(text)
            if (this.thoughts.length > MAX_ACP_UPDATE_CHUNKS) {
              this.thoughts.splice(0, this.thoughts.length - MAX_ACP_UPDATE_CHUNKS)
            }
          }
        }
      }
      this.emit('notification', message)
    }
  }

  private respond(id: number | string, result: unknown): void {
    const message: JsonRpcMessage = { jsonrpc: '2.0', id, result }
    this.proc?.stdin.write(encodeAcpMessage(message), (error) => {
      if (error) this.rejectAll(error instanceof Error ? error : new Error(String(error)))
    })
  }

  private respondError(id: number | string, code: number, message: string): void {
    const response: JsonRpcMessage = { jsonrpc: '2.0', id, error: { code, message } }
    this.proc?.stdin.write(encodeAcpMessage(response), (error) => {
      if (error) this.rejectAll(error instanceof Error ? error : new Error(String(error)))
    })
  }

  private async handleRequest(message: JsonRpcMessage): Promise<void> {
    const { id, method, params } = message
    if (id === undefined || method === undefined) return
    const record = params as Record<string, unknown> | undefined

    try {
      switch (method) {
        case 'session/request_permission':
        case 'session/requestPermission': {
          const options = Array.isArray(record?.options) ? record.options as Array<Record<string, unknown>> : []
          const approved = options.find((o) => o?.kind === 'allow_once' || o?.optionId === 'approve_once')
          if (!approved || typeof approved.optionId !== 'string') {
            throw new AcpError('no allowed permission option found', JSONRPC_INVALID_PARAMS)
          }
          this.respond(id, { outcome: { outcome: 'selected', optionId: approved.optionId } })
          return
        }

        case 'fs/read_text_file':
        case 'fs/readFile':
        case 'fs/read_text': {
          const filePath = await this.resolveSandboxedPath(record?.path)
          const stat = await fs.stat(filePath)
          if (!stat.isFile()) {
            throw new AcpError('not a regular file', JSONRPC_INVALID_PARAMS)
          }
          if (stat.size > MAX_FS_READ_BYTES) {
            throw new AcpError('file exceeds maximum read size', JSONRPC_INVALID_PARAMS)
          }
          const content = await fs.readFile(filePath, 'utf-8')
          this.respond(id, { content })
          return
        }

        case 'fs/write_text_file':
        case 'fs/writeFile':
        case 'fs/write_text': {
          const filePath = await this.resolveSandboxedPath(record?.path)
          const content = typeof record?.content === 'string' ? record.content : String(record?.content ?? '')
          await fs.mkdir(path.dirname(filePath), { recursive: true })
          // Atomic write: write to a sibling temp file and rename into place so a
          // crash cannot leave a partially-written file.
          const tempPath = `${filePath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
          try {
            await fs.writeFile(tempPath, content, 'utf-8')
            await fs.rename(tempPath, filePath)
          } catch (error) {
            try { await fs.unlink(tempPath) } catch { /* ignore cleanup failure */ }
            throw error
          }
          this.respond(id, {})
          return
        }

        case 'fs/read_directory':
        case 'fs/list_directory':
        case 'fs/listDirectory': {
          const dirPath = await this.resolveSandboxedPath(record?.path)
          const entries = await fs.readdir(dirPath)
          this.respond(id, { entries })
          return
        }

        default:
          this.respondError(id, JSONRPC_METHOD_NOT_FOUND, `method not found: ${method}`)
      }
    } catch (error) {
      if (error instanceof AcpError) {
        this.respondError(id, error.code, error.message)
      } else {
        this.respondError(id, JSONRPC_INTERNAL_ERROR, error instanceof Error ? error.message : String(error))
      }
    }
  }

  private async resolveSandboxedPath(requestedPath: unknown): Promise<string> {
    if (typeof requestedPath !== 'string' || requestedPath.length === 0) {
      throw new AcpError('missing or invalid path', JSONRPC_INVALID_PARAMS)
    }
    if (!this.workDir) {
      throw new AcpError('session work directory is not set', JSONRPC_INVALID_PARAMS)
    }

    // Reject Windows drive-relative paths (C:foo) and UNC paths deterministically.
    if (/^[a-zA-Z]:[^\\/]/.test(requestedPath)) {
      throw new AcpError(`drive-relative path not allowed: ${requestedPath}`, JSONRPC_INVALID_PARAMS)
    }
    if (/^\\\\/.test(requestedPath)) {
      throw new AcpError(`UNC path not allowed: ${requestedPath}`, JSONRPC_INVALID_PARAMS)
    }

    // Canonicalize the root once and cache it.
    if (!this.canonicalRoot) {
      this.canonicalRoot = await fs.realpath(this.workDir)
    }
    const root = this.canonicalRoot

    // Resolve relative paths against the canonical root; leave absolute paths as-is
    // so the containment check below rejects ones that are outside the sandbox.
    const resolved = path.isAbsolute(requestedPath) ? path.resolve(requestedPath) : path.resolve(root, requestedPath)

    // Canonicalize the target. If it exists, realpath it; otherwise realpath the
    // deepest existing ancestor and re-append the remaining components so writes to
    // not-yet-existing files are still validated against the real filesystem layout.
    let canonicalTarget: string
    try {
      canonicalTarget = await fs.realpath(resolved)
    } catch {
      const ancestor = await this.findExistingAncestor(resolved)
      if (!ancestor) {
        throw new AcpError(`cannot resolve path: ${requestedPath}`, JSONRPC_INVALID_PARAMS)
      }
      const canonicalAncestor = await fs.realpath(ancestor.path)
      canonicalTarget = path.join(canonicalAncestor, ...ancestor.remaining)
    }

    // Containment check using path.relative (no case-folding).
    const rel = path.relative(root, canonicalTarget)
    if (rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel))) {
      throw new AcpError(`path outside session work directory: ${requestedPath}`, JSONRPC_INVALID_PARAMS)
    }

    return canonicalTarget
  }

  private async findExistingAncestor(resolvedPath: string): Promise<{ path: string; remaining: string[] } | undefined> {
    let current = resolvedPath
    const remaining: string[] = []
    while (true) {
      try {
        const stat = await fs.stat(current)
        if (stat.isDirectory()) {
          return { path: current, remaining }
        }
        // The deepest existing entry is a file, so we cannot create beneath it.
        return undefined
      } catch {
        const parent = path.dirname(current)
        const base = path.basename(current)
        if (parent === current) break
        remaining.unshift(base)
        current = parent
      }
    }
    return undefined
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      clearTimeout(pending.timer)
      pending.reject(error)
    }
  }

  private rejectPending(id: number, error: Error): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    pending.reject(error)
  }
}

function extractSessionId(value: unknown, fallback?: string): string | undefined {
  if (!value || typeof value !== 'object') return fallback
  const record = value as Record<string, unknown>
  for (const key of ['sessionId', 'session_id', 'id', 'session']) {
    if (typeof record[key] === 'string') return record[key] as string
  }
  return fallback
}

export async function runAcpPrompt(options: AcpPromptOptions): Promise<KimiResult> {
  if (options.signal?.aborted) return { ok: false, text: '', error: 'ACP prompt was aborted before start.' }
  // The ACP timeout floor is mandatory: Kimi tasks routinely run longer than a
  // couple of minutes, and the wrapper (not the host) owns the timeout.
  const client = new AcpClient(resolveAcpTimeout(options.timeoutMs))
  const abort = () => client.close()
  options.signal?.addEventListener('abort', abort, { once: true })
  // Cover the race where the signal aborts between the pre-check above and listener
  // registration: adding a listener to an already-aborted signal never fires, so the
  // cancellation would otherwise be silently dropped.
  if (options.signal?.aborted) {
    client.close()
    return { ok: false, text: '', error: 'ACP prompt was aborted before start.' }
  }

  let coalescer: ReturnType<typeof createProgressCoalescer> | undefined
  let watchdog: ReturnType<typeof createStallWatchdog> | undefined
  let todoTracker: ReturnType<typeof createTodoTracker> | undefined
  let onNotification: ((message: JsonRpcMessage) => void) | undefined

  if (options.onProgress) {
    coalescer = createProgressCoalescer(options.onProgress)
    watchdog = createStallWatchdog(options.onProgress)
    todoTracker = createTodoTracker()
    onNotification = (message: JsonRpcMessage) => {
      watchdog?.ping()
      const params = message.params as { update?: { sessionUpdate?: string; content?: unknown; toolCallId?: string; title?: string } } | undefined
      const update = params?.update
      const updateType = update?.sessionUpdate
      switch (updateType) {
        case 'agent_message_chunk':
          coalescer?.add('message', extractAcpText(update?.content))
          break
        case 'agent_thought_chunk':
          coalescer?.add('thought', extractAcpText(update?.content))
          break
        case 'tool_call':
        case 'tool_call_update':
        case 'plan': {
          const text = extractAcpText(update?.content) || JSON.stringify(update)
          const todos = parseAcpTodoPayload(text)
          if (todos && todoTracker?.update(todos)) {
            coalescer?.add('todo', todoTracker.getSummary(), { todoFullList: todoTracker.getFullList() })
          }
          const kind = updateType === 'tool_call' ? 'tool_call' : updateType === 'tool_call_update' ? 'tool_update' : 'plan'
          const toolCallId = typeof update?.toolCallId === 'string' ? update.toolCallId : undefined
          coalescer?.add(kind, text, toolCallId ? { toolCallId } : undefined)
          break
        }
      }
    }
    client.on('notification', onNotification)
  }

  let sessionId: string | undefined
  try {
    client.workDir = options.workDir
    await client.initialize()
    if (options.sessionId && options.sessionMode === 'load') {
      sessionId = extractSessionId(await client.loadSession(options.sessionId), options.sessionId)
    } else if (options.sessionId && options.sessionMode === 'resume') {
      sessionId = extractSessionId(await client.resumeSession(options.sessionId), options.sessionId)
    } else if (!options.sessionId) {
      sessionId = extractSessionId(await client.newSession(options.workDir))
    } else {
      sessionId = options.sessionId
    }

    const result = await client.prompt(sessionId, options.prompt, options.workDir)
    // extractAcpText no longer trims fragments (to preserve inter-token spaces),
    // so trim the fully assembled string here. getUpdateText already trims.
    const updateText = client.getUpdateText()
    const thinkingText = client.getThinkingText()
    let text = extractAcpText(result).trim() || updateText || thinkingText
    if (!text) {
      try {
        text = JSON.stringify(result, null, 2)
      } catch {
        text = '(ACP response is not JSON-serializable)'
      }
    }
    text = truncateUtf8Tail(text, MAX_ACP_METADATA_BYTES)
    let metadata: Record<string, unknown>
    try {
      const serialized = JSON.stringify(result)
      metadata = serialized.length <= MAX_ACP_METADATA_BYTES ? { result } : { truncated: true, size: serialized.length }
    } catch {
      metadata = { truncated: true, reason: 'result is not JSON-serializable' }
    }
    const thinking = options.includeThinking && updateText ? thinkingText || undefined : undefined
    return { ok: true, text: text || '(empty ACP response from Kimi)', thinking, sessionId, metadata }
  } catch (error) {
    const message = options.signal?.aborted
      ? 'Kimi cancelled'
      : error instanceof Error ? error.message : String(error)
    const isTimeout = /timed out/i.test(message)
    return {
      ok: false,
      text: '',
      error: message,
      sessionId,
      resumable: isTimeout && Boolean(sessionId),
    }
  } finally {
    if (onNotification) client.off('notification', onNotification)
    coalescer?.stop()
    watchdog?.stop()
    options.signal?.removeEventListener('abort', abort)
    client.close()
  }
}

export interface ListAcpSessionsOptions {
  limit?: number
  workDir?: string
}

const DEFAULT_ACP_SESSION_LIMIT = 20

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export async function listAcpSessions(options: ListAcpSessionsOptions = {}): Promise<KimiResult> {
  const client = new AcpClient(60_000)
  try {
    await client.initialize()
    const result = await client.listSessions()
    // Filter by working directory and cap the count for parity with kimi_list_sessions;
    // session/list otherwise returns every ACP session across all projects in one blob.
    const sessions = (result as { sessions?: unknown })?.sessions
    if (Array.isArray(sessions)) {
      let filtered = sessions as Array<{ cwd?: unknown }>
      if (options.workDir) {
        const target = normalizePath(options.workDir)
        filtered = filtered.filter((s) => typeof s?.cwd === 'string' && normalizePath(s.cwd) === target)
      }
      const limit = options.limit ?? DEFAULT_ACP_SESSION_LIMIT
      const limited = limit > 0 ? filtered.slice(0, limit) : filtered
      return { ok: true, text: JSON.stringify({ sessions: limited, total: filtered.length }, null, 2) }
    }
    return { ok: true, text: JSON.stringify(result, null, 2) }
  } catch (error) {
    return { ok: false, text: '', error: error instanceof Error ? error.message : String(error) }
  } finally {
    client.close()
  }
}

export async function cancelAcpSession(sessionId: string): Promise<KimiResult> {
  const client = new AcpClient(30_000)
  try {
    await client.initialize()
    const result = await client.cancel(sessionId)
    return { ok: true, text: JSON.stringify(result ?? { cancelled: true }, null, 2), sessionId }
  } catch (error) {
    return { ok: false, text: '', error: error instanceof Error ? error.message : String(error), sessionId }
  } finally {
    client.close()
  }
}
