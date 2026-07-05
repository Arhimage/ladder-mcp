import { wrapCodePrompt } from './code-prompt.js'
import { runAcpPrompt } from './transports/acp.js'
import type { DetailLevel, KimiResult, ProgressReporter } from './types.js'

export interface KimiCodeAgentOptions {
  prompt: string
  workDir: string
  sessionId?: string
  edit?: boolean
  detailLevel?: DetailLevel
  includeThinking?: boolean
  timeoutMs?: number
  signal?: AbortSignal
  onProgress?: ProgressReporter
}

export async function runKimiCodeAgent(options: KimiCodeAgentOptions): Promise<KimiResult> {
  const wrappedPrompt = wrapCodePrompt(options.prompt, options.detailLevel ?? 'normal', options.edit)

  return runAcpPrompt({
    prompt: wrappedPrompt,
    workDir: options.workDir,
    sessionId: options.sessionId,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    onProgress: options.onProgress,
    includeThinking: options.includeThinking ?? false,
    readOnly: options.edit !== true,
  })
}
