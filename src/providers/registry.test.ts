import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../kimi-api.js', () => ({
  runKimiApi: vi.fn(),
}))

vi.mock('./minimax.js', () => ({
  runMinimaxAsk: vi.fn(),
}))

import { runKimiApi } from '../kimi-api.js'
import { runMinimaxAsk } from './minimax.js'
import { runAgentAsk } from './registry.js'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('runAgentAsk', () => {
  it('defaults to Kimi when no provider is given', async () => {
    vi.mocked(runKimiApi).mockResolvedValueOnce({ ok: true, text: 'kimi says hi' })
    const result = await runAgentAsk({ prompt: 'hello' })
    expect(runKimiApi).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'hello' }))
    expect(result).toEqual({ ok: true, text: 'kimi says hi', toolUses: undefined })
  })

  it('dispatches to MiniMax when provider=minimax', async () => {
    vi.mocked(runMinimaxAsk).mockResolvedValueOnce({ ok: true, text: 'minimax says hi' })
    const result = await runAgentAsk({ prompt: 'hello', provider: 'minimax' })
    expect(runMinimaxAsk).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'hello', provider: 'minimax' }))
    expect(result).toEqual({ ok: true, text: 'minimax says hi' })
  })

  it('returns an error for unknown providers', async () => {
    const result = await runAgentAsk({ prompt: 'hello', provider: 'openai' as never })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Unknown provider')
    expect(runKimiApi).not.toHaveBeenCalled()
    expect(runMinimaxAsk).not.toHaveBeenCalled()
  })

  it('passes system and verify prompt to Kimi when context and role are provided', async () => {
    vi.mocked(runKimiApi).mockResolvedValueOnce({ ok: true, text: 'verified' })
    await runAgentAsk({ prompt: 'check this', context: 'const x = 1', role: 'senior', provider: 'kimi' })
    expect(runKimiApi).toHaveBeenCalledWith(expect.objectContaining({
      system: 'senior',
      prompt: expect.stringContaining('const x = 1'),
    }))
  })

  it('passes timeoutMs and maxOutputChars through to the chosen runner', async () => {
    vi.mocked(runKimiApi).mockResolvedValueOnce({ ok: true, text: 'ok' })
    await runAgentAsk({ prompt: 'hello', provider: 'kimi', timeoutMs: 60_000, maxOutputChars: 4_000 })
    expect(runKimiApi).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 60_000, maxOutputChars: 4_000 }))
  })
})
