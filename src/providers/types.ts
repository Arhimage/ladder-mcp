export type ProviderId = 'kimi' | 'minimax'

export interface AgentAskOptions {
  prompt: string
  context?: string
  role?: string
  provider?: ProviderId
  timeoutMs?: number
  maxOutputChars?: number
  includeThinking?: boolean
}

export interface ToolUseBlock {
  id: string
  name: string
  input: unknown
}

export interface AgentResult {
  ok: boolean
  text: string
  thinking?: string
  error?: string
  toolUses?: ToolUseBlock[]
}
