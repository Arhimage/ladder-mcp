import type { ProgressEvent, ProgressKind, ProgressReporter } from './types.js'

export const DEFAULT_STALL_MS = 30_000

const KIND_GLYPH: Record<ProgressKind, string> = {
  status: '•',
  message: '▸',
  thought: '…',
  tool_call: '⚙',
  tool_update: '⚙',
  plan: '◇',
  stall: '⚠',
  todo: '☑',
}

function clockFromIso(iso: string): string {
  // HH:MM:SS in local time; falls back to the raw value if it is not a valid date.
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toTimeString().slice(0, 8)
}

export function makeEvent(kind: ProgressKind, text: string, metadata?: { todoFullList?: string }): ProgressEvent {
  return { kind, text, at: new Date().toISOString(), metadata }
}

// One compact line per event for the background task log, e.g.
// `[12:01:07] ⚙ tool: edit src/index.ts`.
export function formatProgressLine(event: ProgressEvent): string {
  return `[${clockFromIso(event.at)}] ${KIND_GLYPH[event.kind]} ${event.kind}: ${event.text}`
}

// Task-log variant: for TODO events, append the full multi-line list so the
// accumulating background log contains complete snapshots, while live progress
// surfaces only the compact one-line summary.
export function formatTaskLogLine(event: ProgressEvent): string {
  const base = formatProgressLine(event)
  const fullList = event.metadata?.todoFullList
  if (event.kind === 'todo' && fullList) {
    return `${base}\n${fullList.split('\n').map((line) => `    ${line}`).join('\n')}`
  }
  return base
}

// ---------------------------------------------------------------------------
// TODO tracker
// ---------------------------------------------------------------------------

export type TodoStatus = 'done' | 'in_progress' | 'pending'

export interface TodoItem {
  text: string
  status: TodoStatus
}

export interface TodoTracker {
  update(items: TodoItem[]): boolean
  getItems(): readonly TodoItem[]
  getSummary(): string
  getFullList(): string
  clear(): void
}

const TODO_STATUS_MARKERS: Record<TodoStatus, string> = {
  done: '✓',
  in_progress: '·',
  pending: '·',
}

export function formatTodoSummary(items: TodoItem[]): string {
  if (items.length === 0) return 'TODO 0/0'
  const done = items.filter((i) => i.status === 'done').length
  const markers = items.map((i) => TODO_STATUS_MARKERS[i.status]).join('')
  const current = items.find((i) => i.status === 'in_progress')
  const now = current ? ` · now: ${current.text}` : ''
  return `TODO ${done}/${items.length} ${markers}${now}`
}

export function formatTodoFullList(items: TodoItem[]): string {
  if (items.length === 0) return '(empty todo list)'
  return items.map((i) => `[${i.status}] ${i.text}`).join('\n')
}

export function createTodoTracker(): TodoTracker {
  let items: TodoItem[] = []

  const sameItems = (a: TodoItem[], b: TodoItem[]) => {
    if (a.length !== b.length) return false
    return a.every((item, idx) => item.text === b[idx].text && item.status === b[idx].status)
  }

  return {
    update(next) {
      if (sameItems(items, next)) return false
      items = next.map((i) => ({ text: i.text.trim(), status: i.status }))
      return true
    },
    getItems() {
      return items
    },
    getSummary() {
      return formatTodoSummary(items)
    },
    getFullList() {
      return formatTodoFullList(items)
    },
    clear() {
      items = []
    },
  }
}

const TODO_SNAPSHOT_MARKER = 'Current todo list:'
const TODO_BOILERPLATE_MARKER = 'Ensure that you continue to use the todo list'

// Parses the human-readable snapshot that Kimi's TodoList tool returns in CLI
// `role:tool` results and in ACP `tool_call_update` content.
export function parseCliTodoSnapshot(text: string): TodoItem[] | undefined {
  const markerIndex = text.indexOf(TODO_SNAPSHOT_MARKER)
  if (markerIndex < 0) return undefined

  const start = markerIndex + TODO_SNAPSHOT_MARKER.length
  const raw = text.slice(start)
  // Stop before the trailing boilerplate if present.
  const end = raw.indexOf(TODO_BOILERPLATE_MARKER)
  const section = (end < 0 ? raw : raw.slice(0, end)).trim()
  if (!section) return undefined

  const items: TodoItem[] = []
  for (const line of section.split(/\r?\n/)) {
    const trimmed = line.trim()
    const match = trimmed.match(/^\[(done|in_progress|pending)\]\s*(.+)$/) ?? trimmed.match(/^(done|in_progress|pending):\s*(.+)$/i)
    if (!match) {
      // First non-matching blank line is tolerated; a second non-matching line
      // marks the end of the list.
      if (items.length > 0) break
      continue
    }
    const status = match[1].toLowerCase() as TodoStatus
    const text = match[2].trim()
    if (text) items.push({ status, text })
  }
  return items.length > 0 ? items : undefined
}

// Parses either a JSON `{"todos":[{"title":"...","status":"..."}]}` payload
// (common in ACP `tool_call_update`) or a human-readable snapshot.
export function parseAcpTodoPayload(text: string): TodoItem[] | undefined {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>
        const todos = record.todos ?? record.items ?? record.plan
        if (Array.isArray(todos)) {
          const items: TodoItem[] = []
          for (const entry of todos) {
            if (!entry || typeof entry !== 'object') continue
            const e = entry as Record<string, unknown>
            const text = typeof e.title === 'string' ? e.title : typeof e.content === 'string' ? e.content : typeof e.text === 'string' ? e.text : ''
            const rawStatus = typeof e.status === 'string' ? e.status.toLowerCase() : 'pending'
            const status: TodoStatus = rawStatus === 'done' || rawStatus === 'completed' || rawStatus === 'complete' ? 'done' : rawStatus === 'in_progress' || rawStatus === 'in progress' || rawStatus === 'active' ? 'in_progress' : 'pending'
            if (text.trim()) items.push({ text: text.trim(), status })
          }
          if (items.length > 0) return items
        }
      }
    } catch {
      // Fall through to snapshot parsing.
    }
  }
  return parseCliTodoSnapshot(text)
}

export const DEFAULT_DWELL_MS = 1_200
export const DEFAULT_TODO_PRIORITY_MS = 5_000
export const PREVIEW_MAX_CHARS = 90
export const TAIL_MAX_CHARS = 120

function sliceByCodePoints(text: string, maxChars: number): string {
  return [...text].slice(-maxChars).join('')
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function formatPreview(tail: string, maxChars: number): string {
  const preview = collapseWhitespace(tail)
  if (preview.length === 0) return ''
  const codePoints = [...preview]
  if (codePoints.length <= maxChars) return preview
  return `…${codePoints.slice(-maxChars).join('').trimStart()}`
}

export interface ProgressCoalescerOptions {
  dwellMs?: number
  previewMaxChars?: number
  tailMaxChars?: number
  todoPriorityMs?: number
}

export interface ProgressCoalescer {
  add(kind: ProgressKind, text: string, metadata?: { todoFullList?: string }): void
  flush(): void
  stop(): void
}

// Coalesces high-frequency `message`/`thought` streaming text into a single
// watchable preview line, emitted at most once per `dwellMs`. Action events
// (`tool_call`, `tool_update`, `plan`) are forwarded immediately, after flushing
// any pending preview so ordering is preserved. `todo` events are also immediate
// and start a short priority window during which `message`/`thought` previews are
// suppressed so the checklist line stays readable.
export function createProgressCoalescer(
  reporter: ProgressReporter,
  options?: ProgressCoalescerOptions,
): ProgressCoalescer {
  const dwellMs = options?.dwellMs ?? DEFAULT_DWELL_MS
  const previewMaxChars = options?.previewMaxChars ?? PREVIEW_MAX_CHARS
  const tailMaxChars = options?.tailMaxChars ?? TAIL_MAX_CHARS
  const todoPriorityMs = options?.todoPriorityMs ?? DEFAULT_TODO_PRIORITY_MS

  const tails: Record<'message' | 'thought', string> = { message: '', thought: '' }
  let timer: NodeJS.Timeout | undefined
  let priorityTimer: NodeJS.Timeout | undefined
  let priorityUntil = 0

  const emitTails = () => {
    for (const kind of ['message', 'thought'] as const) {
      const tail = tails[kind]
      if (!tail) continue
      const text = formatPreview(tail, previewMaxChars)
      tails[kind] = ''
      if (text) reporter(makeEvent(kind, text))
    }
  }

  const flush = () => {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    emitTails()
  }

  const clearPriority = () => {
    priorityUntil = 0
    if (priorityTimer) {
      clearTimeout(priorityTimer)
      priorityTimer = undefined
    }
  }

  const schedule = () => {
    if (timer) return
    const now = Date.now()
    if (now < priorityUntil) {
      // Message/thought previews are deferred while a TODO line is on screen.
      // Arm a single timer that will emit the accumulated tail once the window
      // expires; additional streaming text during the window only updates tails.
      if (!priorityTimer) {
        priorityTimer = setTimeout(() => {
          priorityTimer = undefined
          priorityUntil = 0
          emitTails()
        }, priorityUntil - now)
        priorityTimer.unref?.()
      }
      return
    }
    timer = setTimeout(() => {
      timer = undefined
      emitTails()
    }, dwellMs)
    timer.unref?.()
  }

  const appendTail = (kind: 'message' | 'thought', text: string) => {
    tails[kind] = sliceByCodePoints(tails[kind] + text, tailMaxChars)
  }

  const add: ProgressCoalescer['add'] = (kind, text, metadata) => {
    if (kind === 'tool_call' || kind === 'tool_update' || kind === 'plan') {
      // During a TODO priority window, action events still surface but chatty
      // message/thought previews stay suppressed so the checklist remains visible.
      if (Date.now() < priorityUntil) {
        reporter(makeEvent(kind, text))
        return
      }
      flush()
      reporter(makeEvent(kind, text))
      return
    }
    if (kind === 'todo') {
      flush()
      clearPriority()
      priorityUntil = Date.now() + todoPriorityMs
      reporter(makeEvent(kind, text, metadata))
      schedule()
      return
    }
    if (kind === 'message' || kind === 'thought') {
      appendTail(kind, text)
      schedule()
    }
  }

  const stop = () => {
    clearPriority()
    flush()
  }

  return { add, flush, stop }
}

// Fires a synthetic `stall` event when no activity is observed for `stallMs`, so a
// silent hang becomes visible instead of looking identical to ongoing work. (A busy
// loop, by contrast, shows up as repeated tool_call lines in the event stream.)
export interface StallWatchdog {
  ping(): void
  stop(): void
}

export function createStallWatchdog(reporter: ProgressReporter, stallMs = DEFAULT_STALL_MS): StallWatchdog {
  let timer: NodeJS.Timeout | undefined
  let stopped = false

  const arm = () => {
    if (stopped) return
    timer = setTimeout(() => {
      try {
        reporter(makeEvent('stall', `no activity for ${Math.round(stallMs / 1000)}s — Kimi may be stuck`))
      } catch {
        // A throwing reporter must not kill the watchdog: always re-arm below.
      }
      arm()
    }, stallMs)
    // Do not keep the event loop alive solely for the watchdog.
    timer.unref?.()
  }

  arm()

  return {
    ping() {
      if (stopped) return
      if (timer) clearTimeout(timer)
      arm()
    },
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
    },
  }
}

// Minimal shape of the MCP tool handler `extra` we depend on, kept local so this
// module is not coupled to a specific SDK version's exported types.
interface McpProgressExtra {
  sendNotification?: (notification: {
    method: 'notifications/progress'
    params: { progressToken: string | number; progress: number; total?: number; message?: string }
  }) => void | Promise<void>
  _meta?: { progressToken?: string | number }
}

// Bridges progress events to MCP `notifications/progress` so a blocking foreground
// call shows live status in clients that render progress. No-op when the client did
// not supply a progressToken (progress is opt-in per the MCP spec).
export function createMcpProgressReporter(extra: unknown): ProgressReporter {
  const typed = (extra ?? {}) as McpProgressExtra
  const token = typed._meta?.progressToken
  // Token is opt-in and must be a string or number per the MCP spec; a non-conforming
  // client could send null/other, which would fail SDK validation downstream.
  if ((typeof token !== 'string' && typeof token !== 'number') || typeof typed.sendNotification !== 'function') {
    return () => {}
  }
  const send = typed.sendNotification
  let progress = 0
  return (event) => {
    progress += 1
    // Defer the call so a *synchronous* throw from sendNotification is captured by the
    // promise chain too (Promise.resolve(fn()) would let a sync throw escape).
    void Promise.resolve()
      .then(() =>
        send({
          method: 'notifications/progress',
          params: { progressToken: token, progress, message: formatProgressLine(event) },
        }),
      )
      .catch(() => {
        // A failed progress notification must never break the underlying work.
      })
  }
}

// Combine several reporters into one (e.g. task-log append + MCP notifications).
export function combineReporters(...reporters: Array<ProgressReporter | undefined>): ProgressReporter {
  const active = reporters.filter((r): r is ProgressReporter => typeof r === 'function')
  if (active.length === 0) return () => {}
  if (active.length === 1) return active[0]
  return (event) => {
    for (const reporter of active) {
      try {
        reporter(event)
      } catch {
        // Isolate reporters: one throwing must not stop the others.
      }
    }
  }
}
