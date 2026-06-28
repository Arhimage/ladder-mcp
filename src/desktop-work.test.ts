import { describe, expect, it } from 'vitest'
import { MAX_PROBE_BODY_BYTES, buildBudgetProbeGuide, readBodyCapped } from './desktop-work.js'

function streamResponse(body: Uint8Array): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(body)
      controller.close()
    },
  })
  return new Response(stream)
}

describe('desktop work probes', () => {
  it('documents read-only budget probe safety boundaries', () => {
    const guide = buildBudgetProbeGuide(false)
    expect(guide).toContain('does not read desktop token-store')
    expect(guide).toContain('does not replay web auth')
    expect(guide).toContain('does not submit desktop Work tasks')
  })

  it('returns full small bodies without truncation', async () => {
    const { text, truncated } = await readBodyCapped(streamResponse(new TextEncoder().encode('{"ok":true}')))
    expect(truncated).toBe(false)
    expect(text).toBe('{"ok":true}')
  })

  it('caps oversized response bodies', async () => {
    const big = new Uint8Array(MAX_PROBE_BODY_BYTES + 50_000).fill(0x61) // 'a'
    const { text, truncated } = await readBodyCapped(streamResponse(big))
    expect(truncated).toBe(true)
    expect(Buffer.byteLength(text, 'utf-8')).toBeLessThanOrEqual(MAX_PROBE_BODY_BYTES)
  })

  it('caps non-streaming fallback response bodies', async () => {
    const big = 'a'.repeat(MAX_PROBE_BODY_BYTES + 10_000)
    const mockResponse = { body: null, text: async () => big } as unknown as Response
    const { text, truncated } = await readBodyCapped(mockResponse)
    expect(truncated).toBe(true)
    expect(Buffer.byteLength(text, 'utf-8')).toBeLessThanOrEqual(MAX_PROBE_BODY_BYTES)
  })
})
