import { runKimiApi } from '../kimi-api.js'
import { runMinimaxAsk } from './minimax.js'
import type { AgentAskOptions, AgentResult, ProviderId } from './types.js'

export const DEFAULT_PROVIDER: ProviderId = 'kimi'
export const SUPPORTED_PROVIDERS: ProviderId[] = ['kimi', 'minimax']

const AI_CONSUMER_NOTICE = `\nIMPORTANT: Your response will be consumed by another AI model with limited context. Prioritize density, concrete file references, and structured markdown.`

function buildKimiPrompt(options: AgentAskOptions): { prompt: string; system?: string } {
  if (options.context) {
    const focus = options.prompt.trim() || 'Independently verify correctness. Surface bugs, edge cases, security issues, and concrete improvements.'
    const system = options.role?.trim() || 'You are a meticulous, independent senior engineer. Be skeptical, specific, and actionable.'
    const prompt = `## Your task\n${focus}\n\n## Material to verify\n${options.context}${AI_CONSUMER_NOTICE}`
    return { prompt, system }
  }
  return { prompt: options.prompt, system: options.role }
}

export async function runAgentAsk(options: AgentAskOptions): Promise<AgentResult> {
  const provider = options.provider ?? DEFAULT_PROVIDER
  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    return {
      ok: false,
      text: '',
      error: `Unknown provider: ${provider}. Supported: ${SUPPORTED_PROVIDERS.join(', ')}`,
    }
  }

  if (provider === 'kimi') {
    const { prompt, system } = buildKimiPrompt(options)
    const result = await runKimiApi({
      prompt,
      system,
      timeoutMs: options.timeoutMs,
      maxOutputChars: options.maxOutputChars,
    })
    return { ...result, toolUses: undefined }
  }

  return runMinimaxAsk(options)
}
