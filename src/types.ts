export interface KimiResult {
  ok: boolean
  text: string
  thinking?: string
  error?: string
  sessionId?: string
  resumable?: boolean
  exitCode?: number
  exitClass?: string
  stderrTail?: string
  affectedFiles?: string[]
  metadata?: Record<string, unknown>
}

export type DetailLevel = 'summary' | 'normal' | 'detailed'

// Live-progress events surfaced while Kimi works, so callers can tell a running job
// apart from a stalled one. `stall` is synthetic (emitted by the watchdog, not Kimi).
export type ProgressKind =
  | 'status'
  | 'message'
  | 'thought'
  | 'tool_call'
  | 'tool_update'
  | 'plan'
  | 'stall'
  | 'todo'

export interface ProgressEvent {
  kind: ProgressKind
  text: string
  at: string
  metadata?: ProgressMetadata
}

export interface ProgressMetadata {
  todoFullList?: string
}

export type ProgressReporter = (event: ProgressEvent) => void

export interface KimiSession {
  id: string
  title: string
  workDir: string
  sessionDir?: string
  lastModified: string
}
