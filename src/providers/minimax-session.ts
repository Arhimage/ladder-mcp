import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

export interface MinimaxTextContentBlock {
  type: 'text'
  text: string
}

export interface MinimaxThinkingContentBlock {
  type: 'thinking'
  thinking: string
  signature?: string
}

export interface MinimaxToolUseContentBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface MinimaxToolResultContentBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string
}

export type MinimaxContentBlock =
  | MinimaxTextContentBlock
  | MinimaxThinkingContentBlock
  | MinimaxToolUseContentBlock
  | MinimaxToolResultContentBlock

export interface MinimaxMessage {
  role: 'user' | 'assistant'
  content: string | MinimaxContentBlock[]
}

export interface MinimaxSession {
  id: string
  provider: 'minimax'
  workDir: string
  createdAt: string
  updatedAt: string
  messages: MinimaxMessage[]
  title?: string
  lastResult?: string
  metadata?: Record<string, unknown>
}

export interface SessionLoadResult {
  ok: true
  session: MinimaxSession
}

export interface SessionError {
  ok: false
  error: string
}

const SESSION_FILE_EXTENSION = '.json'
const SESSION_ID_PREFIX = 'minimax_session_'

function normalizeDir(dir: string): string {
  return path.normalize(dir).toLowerCase()
}

export function getMinimaxSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.USERPROFILE || env.HOME || os.homedir()
  return path.join(home, '.ladder-mcp', 'minimax', 'sessions')
}

export function isMinimaxSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(SESSION_ID_PREFIX)
}

export function generateMinimaxSessionId(): string {
  return `${SESSION_ID_PREFIX}${crypto.randomUUID()}`
}

function sessionFilePath(sessionId: string, sessionsDir: string): string {
  return path.join(sessionsDir, `${sessionId}${SESSION_FILE_EXTENSION}`)
}

export async function createMinimaxSession(
  workDir: string,
  deps: { sessionsDir?: string; now?: () => string; generateId?: () => string } = {},
): Promise<MinimaxSession> {
  const now = deps.now ? deps.now() : new Date().toISOString()
  const session: MinimaxSession = {
    id: (deps.generateId ? deps.generateId() : generateMinimaxSessionId()),
    provider: 'minimax',
    workDir: path.resolve(workDir),
    createdAt: now,
    updatedAt: now,
    messages: [],
  }
  await saveMinimaxSession(session, deps)
  return session
}

export async function loadMinimaxSession(
  sessionId: string,
  options: { workDir?: string; sessionsDir?: string } = {},
): Promise<SessionLoadResult | SessionError> {
  if (!isMinimaxSessionId(sessionId)) {
    return { ok: false, error: `Invalid MiniMax session id: ${sessionId}` }
  }

  const sessionsDir = options.sessionsDir ?? getMinimaxSessionsDir()
  const filePath = sessionFilePath(sessionId, sessionsDir)
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf-8')
  } catch (error) {
    return { ok: false, error: `MiniMax session not found: ${sessionId}` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, error: `MiniMax session file is corrupt: ${sessionId}` }
  }

  const session = validateSessionShape(parsed)
  if (!session.ok) {
    return { ok: false, error: session.error }
  }

  if (options.workDir !== undefined) {
    if (normalizeDir(session.session.workDir) !== normalizeDir(options.workDir)) {
      return {
        ok: false,
        error: `Session work_dir mismatch: expected ${options.workDir}, got ${session.session.workDir}`,
      }
    }
  }

  return { ok: true, session: session.session }
}

function validateSessionShape(value: unknown): SessionLoadResult | SessionError {
  if (typeof value !== 'object' || value === null) {
    return { ok: false, error: 'Session file is not a JSON object.' }
  }
  const record = value as Record<string, unknown>

  if (!isMinimaxSessionId(record.id)) {
    return { ok: false, error: `Invalid session id in file: ${String(record.id)}` }
  }
  if (record.provider !== 'minimax') {
    return { ok: false, error: `Unexpected provider in session file: ${String(record.provider)}` }
  }
  if (typeof record.workDir !== 'string') {
    return { ok: false, error: 'Session file missing workDir.' }
  }
  if (typeof record.createdAt !== 'string' || typeof record.updatedAt !== 'string') {
    return { ok: false, error: 'Session file missing timestamps.' }
  }
  if (!Array.isArray(record.messages)) {
    return { ok: false, error: 'Session file messages is not an array.' }
  }

  return {
    ok: true,
    session: {
      id: record.id,
      provider: 'minimax',
      workDir: record.workDir,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      messages: record.messages as MinimaxMessage[],
      title: typeof record.title === 'string' ? record.title : undefined,
      lastResult: typeof record.lastResult === 'string' ? record.lastResult : undefined,
      metadata: typeof record.metadata === 'object' && record.metadata !== null
        ? (record.metadata as Record<string, unknown>)
        : undefined,
    },
  }
}

export async function saveMinimaxSession(
  session: MinimaxSession,
  deps: { sessionsDir?: string; now?: () => string } = {},
): Promise<void> {
  const sessionsDir = deps.sessionsDir ?? getMinimaxSessionsDir()
  await fs.mkdir(sessionsDir, { recursive: true })

  const updated: MinimaxSession = {
    ...session,
    updatedAt: deps.now ? deps.now() : new Date().toISOString(),
  }

  const filePath = sessionFilePath(updated.id, sessionsDir)
  const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`
  try {
    await fs.writeFile(tempPath, JSON.stringify(updated, null, 2), 'utf-8')
    await fs.rename(tempPath, filePath)
  } catch (error) {
    try {
      await fs.unlink(tempPath)
    } catch {
      // ignore cleanup failure
    }
    throw error
  }
}

const activeSessionLocks = new Map<string, () => void>()

export function acquireMinimaxSessionLock(sessionId: string): (() => void) | undefined {
  if (activeSessionLocks.has(sessionId)) return undefined
  let released = false
  const release = () => {
    if (released) return
    released = true
    activeSessionLocks.delete(sessionId)
  }
  activeSessionLocks.set(sessionId, release)
  return release
}

export function clearMinimaxSessionLocks(): void {
  activeSessionLocks.clear()
}
