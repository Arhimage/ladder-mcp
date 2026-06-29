// Response envelope and size-guard helpers shared across MCP tool handlers.
// These live in one place so every tool answer follows the same compact-by-default
// contract and no single reply can blow through the host's token budget.

export interface TerminalEnvelope {
  status: 'success' | 'timeout' | 'crash' | 'cancel' | 'error'
  sessionId?: string
  resumable?: boolean
  exitCode?: number
  exitClass?: string
  stderrTail?: string
  affectedFiles?: string[]
  continuation?: {
    instruction: string
    newSession: boolean
    sessionId?: string
  }
}

export interface ResponseGuardOptions {
  maxChars?: number
  structured?: unknown
}

export const DEFAULT_TOOL_MAX_CHARS = 8_000
const TRUNCATION_NOTICE = '\n\n---\nResponse truncated by Ladder_mcp size guard.'

export function truncateAtCodePointBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  // [...text] iterates Unicode code points, so we never split a surrogate pair.
  const points = [...text]
  if (points.length <= maxChars) return text
  return points.slice(0, maxChars).join('')
}

// Truncate at a clean structural boundary (section header or paragraph break)
// so the remaining tail is still readable. Falls back to ~80% of the budget if
// no good boundary exists.
export function truncateAtBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const slice = text.slice(0, maxChars)
  const cutPoint = Math.max(slice.lastIndexOf('\n## '), slice.lastIndexOf('\n\n'), Math.floor(maxChars * 0.8))
  return `${slice.slice(0, cutPoint).trimEnd()}\n\n---\nOutput truncated (${text.length.toLocaleString()} chars exceeded ${maxChars.toLocaleString()} char budget).`
}

export function guardResponse(text: string, options?: ResponseGuardOptions): { text: string; truncated: boolean } {
  const maxChars = options?.maxChars ?? DEFAULT_TOOL_MAX_CHARS
  if (text.length <= maxChars) return { text, truncated: false }
  const head = truncateAtCodePointBoundary(text, Math.max(0, maxChars - TRUNCATION_NOTICE.length))
  return { text: `${head}${TRUNCATION_NOTICE}`, truncated: true }
}

export function formatTerminalEnvelope(envelope: TerminalEnvelope): string {
  const parts: string[] = []
  parts.push(`Status: ${envelope.status}`)
  if (envelope.sessionId) parts.push(`Session: ${envelope.sessionId}`)
  if (envelope.resumable !== undefined) parts.push(`Resumable: ${envelope.resumable}`)
  if (envelope.exitCode !== undefined) parts.push(`Exit code: ${envelope.exitCode} (${envelope.exitClass ?? 'unknown'})`)
  if (envelope.stderrTail) parts.push(`stderr tail:\n${envelope.stderrTail}`)
  if (envelope.affectedFiles && envelope.affectedFiles.length > 0) {
    parts.push(`Affected files:\n${envelope.affectedFiles.map((f) => `- ${f}`).join('\n')}`)
  }
  if (envelope.continuation) {
    parts.push(
      '',
      'CONTINUATION INSTRUCTION:',
      envelope.continuation.instruction,
      `Resume with: new_session=${envelope.continuation.newSession}${envelope.continuation.sessionId ? `, session_id=${envelope.continuation.sessionId}` : ''}`,
    )
  }
  return parts.join('\n')
}
