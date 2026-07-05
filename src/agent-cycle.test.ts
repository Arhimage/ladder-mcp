import { describe, expect, it, vi } from 'vitest'
import { parseVerdict, runAgentCycle, type AgentCycleOptions, type CodeRunRequest } from './agent-cycle.js'
import type { KimiResult } from './types.js'

const baseOptions: AgentCycleOptions = {
  prompt: 'Add a hello() function',
  workDir: 'C:\\repo',
  maxIterations: 3,
  coderProvider: 'minimax',
  reviewerProvider: 'minimax',
}

function ok(text: string, sessionId: string): KimiResult {
  return { ok: true, text, sessionId }
}

const noDiff = async () => '## git status --porcelain\n M src/a.ts\n\n## git diff HEAD\n+hello'

describe('parseVerdict', () => {
  it('parses APPROVED', () => {
    expect(parseVerdict('looks good\nVERDICT: APPROVED').verdict).toBe('approved')
  })
  it('parses REVISE with notes', () => {
    const result = parseVerdict('1. fix X\nVERDICT: REVISE')
    expect(result.verdict).toBe('revise')
    expect(result.notes).toContain('fix X')
  })
  it('uses the last verdict when several appear', () => {
    expect(parseVerdict('VERDICT: REVISE ... later ... VERDICT: APPROVED').verdict).toBe('approved')
  })
  it('is case-insensitive', () => {
    expect(parseVerdict('verdict: approved').verdict).toBe('approved')
  })
  it('returns unparsed when no verdict line exists', () => {
    expect(parseVerdict('great work, ship it').verdict).toBe('unparsed')
  })
})

describe('runAgentCycle', () => {
  it('approves on the first iteration', async () => {
    const calls: CodeRunRequest[] = []
    const runCode = vi.fn(async (request: CodeRunRequest) => {
      calls.push(request)
      return request.edit ? ok('implemented hello()', 'coder_1') : ok('VERDICT: APPROVED', 'rev_1')
    })
    const result = await runAgentCycle(baseOptions, { runCode, getDiff: noDiff })

    expect(result.ok).toBe(true)
    expect(result.finalVerdict).toBe('approved')
    expect(result.iterationsUsed).toBe(1)
    expect(result.coderSessionId).toBe('coder_1')
    expect(result.reviewerSessionId).toBe('rev_1')
    expect(calls).toHaveLength(2)
    // reviewer runs read-only and sees the diff
    expect(calls[1].edit).toBe(false)
    expect(calls[1].prompt).toContain('git diff HEAD')
    expect(calls[1].prompt).toContain('implemented hello()')
  })

  it('feeds reviewer notes back into the same coder session on REVISE', async () => {
    let reviewCount = 0
    const calls: CodeRunRequest[] = []
    const runCode = vi.fn(async (request: CodeRunRequest) => {
      calls.push(request)
      if (request.edit) return ok('did work', 'coder_1')
      reviewCount++
      return reviewCount === 1
        ? ok('1. missing tests\nVERDICT: REVISE', 'rev_1')
        : ok('VERDICT: APPROVED', 'rev_1')
    })
    const result = await runAgentCycle(baseOptions, { runCode, getDiff: noDiff })

    expect(result.finalVerdict).toBe('approved')
    expect(result.iterationsUsed).toBe(2)
    const secondCoderCall = calls[2]
    expect(secondCoderCall.edit).toBe(true)
    expect(secondCoderCall.sessionId).toBe('coder_1')
    expect(secondCoderCall.prompt).toContain('missing tests')
    // reviewer session is also resumed
    expect(calls[3].sessionId).toBe('rev_1')
  })

  it('stops at max_iterations with finalVerdict=revise', async () => {
    const runCode = vi.fn(async (request: CodeRunRequest) =>
      request.edit ? ok('did work', 'coder_1') : ok('1. still broken\nVERDICT: REVISE', 'rev_1'),
    )
    const result = await runAgentCycle({ ...baseOptions, maxIterations: 2 }, { runCode, getDiff: noDiff })

    expect(result.ok).toBe(true)
    expect(result.finalVerdict).toBe('revise')
    expect(result.iterationsUsed).toBe(2)
    expect(result.text).toContain('max_iterations')
  })

  it('tolerates one unparsed verdict but stops after two in a row', async () => {
    const runCode = vi.fn(async (request: CodeRunRequest) =>
      request.edit ? ok('did work', 'coder_1') : ok('no verdict here', 'rev_1'),
    )
    const result = await runAgentCycle(baseOptions, { runCode, getDiff: noDiff })

    expect(result.ok).toBe(false)
    expect(result.finalVerdict).toBe('unparsed')
    expect(result.iterationsUsed).toBe(2)
  })

  it('returns an error when the coder run fails', async () => {
    const runCode = vi.fn(async (request: CodeRunRequest): Promise<KimiResult> =>
      request.edit
        ? { ok: false, text: '', error: 'mmx exploded', sessionId: 'coder_1' }
        : ok('VERDICT: APPROVED', 'rev_1'),
    )
    const result = await runAgentCycle(baseOptions, { runCode, getDiff: noDiff })

    expect(result.ok).toBe(false)
    expect(result.finalVerdict).toBe('incomplete')
    expect(result.error).toContain('mmx exploded')
    expect(result.coderSessionId).toBe('coder_1')
  })

  it('surfaces reviewer failure but keeps the coder session id', async () => {
    const runCode = vi.fn(async (request: CodeRunRequest): Promise<KimiResult> =>
      request.edit ? ok('did work', 'coder_1') : { ok: false, text: '', error: 'review died' },
    )
    const result = await runAgentCycle(baseOptions, { runCode, getDiff: noDiff })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('review died')
    expect(result.coderSessionId).toBe('coder_1')
  })

  it('stops immediately when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const runCode = vi.fn()
    const result = await runAgentCycle({ ...baseOptions, signal: controller.signal }, { runCode, getDiff: noDiff })

    expect(result.ok).toBe(false)
    expect(result.finalVerdict).toBe('incomplete')
    expect(runCode).not.toHaveBeenCalled()
  })

  it('tells the reviewer when work_dir is not a git repo', async () => {
    const calls: CodeRunRequest[] = []
    const runCode = vi.fn(async (request: CodeRunRequest) => {
      calls.push(request)
      return request.edit ? ok('did work', 'coder_1') : ok('VERDICT: APPROVED', 'rev_1')
    })
    await runAgentCycle(baseOptions, { runCode, getDiff: async () => undefined })
    expect(calls[1].prompt).toContain('not a git repository')
  })

  it('reports progress per phase', async () => {
    const events: string[] = []
    const runCode = vi.fn(async (request: CodeRunRequest) =>
      request.edit ? ok('did work', 'coder_1') : ok('VERDICT: APPROVED', 'rev_1'),
    )
    await runAgentCycle(
      { ...baseOptions, onProgress: (event) => events.push(event.text) },
      { runCode, getDiff: noDiff },
    )
    expect(events.some((text) => text.includes('coder'))).toBe(true)
    expect(events.some((text) => text.includes('verdict approved'))).toBe(true)
  })
})
