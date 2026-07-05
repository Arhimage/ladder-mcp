// Response envelope and size-guard helpers shared across MCP tool handlers.
// These live in one place so every tool answer follows the same compact-by-default
// contract and no single reply can blow through the host's token budget.

export interface TerminalEnvelope {
  status: 'success' | 'timeout' | 'cancel' | 'error'
  sessionId?: string
  resumable?: boolean
  resumeToolName?: string
  continuation?: {
    instruction: string
    sessionId?: string
  }
}

export interface ResponseGuardOptions {
  maxChars?: number
  structured?: unknown
}

// ~20K tokens at the ~4 chars/token heuristic — comfortably under the 25K-token
// cap Claude Code applies to MCP tool results (MAX_MCP_OUTPUT_TOKENS), so the guard
// only catches pathological outputs instead of forcing routine re-pagination.
export const DEFAULT_TOOL_MAX_CHARS = 80_000
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
  if (envelope.continuation) {
    const resumeToolName = envelope.resumeToolName ?? 'agent_code'
    parts.push(
      '',
      'CONTINUATION INSTRUCTION:',
      envelope.continuation.instruction,
      `Resume with: ${resumeToolName}${envelope.continuation.sessionId ? ` session_id=${envelope.continuation.sessionId}` : ''}`,
    )
  }
  return parts.join('\n')
}

export interface TerminalEnvelopeSource {
  ok: boolean
  error?: string
  sessionId?: string
  resumable?: boolean
  resumeToolName?: string
}

export function buildTerminalEnvelope(result: TerminalEnvelopeSource): TerminalEnvelope {
  const status = result.ok
    ? 'success'
    : result.resumable
      ? 'timeout'
      : result.error?.toLowerCase().includes('cancel')
        ? 'cancel'
        : 'error'
  const resumeToolName = result.resumeToolName ?? 'agent_code'
  return {
    status,
    sessionId: result.sessionId,
    resumable: result.resumable,
    resumeToolName,
    ...(result.resumable
      ? {
          continuation: {
            instruction:
              `The run timed out and its process was stopped, but the provider persists session state on disk. Continue the same session by calling ${resumeToolName} again with the session_id below; do not start a new task or do the work yourself. Resume is best-effort.`,
            sessionId: result.sessionId,
          },
        }
      : {}),
  }
}

export function wrapThinking(text: string, thinking: string | undefined, includeThinking: boolean, tag = 'thinking'): string {
  return thinking && includeThinking ? `<${tag}>\n${thinking}\n</${tag}>\n\n${text}` : text
}
