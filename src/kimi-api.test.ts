import { describe, expect, it, vi } from 'vitest'

vi.mock('./environment.js', () => ({
  loadApiAuth: vi.fn(() => ({ baseUrl: 'http://localhost', apiKey: 'test-key' })),
}))

describe('kimi-api timeout', () => {
  it('clamps an invalid timeout to the default so it does not abort immediately', async () => {
    vi.useFakeTimers()
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation((_input, init) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined
        if (signal?.aborted) {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
          return
        }
        const onAbort = () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        }
        signal?.addEventListener('abort', onAbort, { once: true })
      })
    })

    const { runKimiApi } = await import('./kimi-api.js')
    const resultPromise = runKimiApi({ prompt: 'hello', timeoutMs: 0 })

    vi.advanceTimersByTime(1)
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(300_000)
    const result = await resultPromise
    expect(result.error).toContain('timed out')

    vi.useRealTimers()
    fetchSpy.mockRestore()
  })
})
