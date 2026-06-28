import { describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { appendCapped, applyReadOnlyGuard, buildKimiArgs, parseKimiStreamJson, truncateAtBoundary } from './kimi-runner.js'
import type { ProgressEvent } from './types.js'

vi.mock('./environment.js', () => ({
  buildKimiEnv: vi.fn(() => ({})),
  resolveKimiPaths: vi.fn(() => ({ binaryPath: 'kimi.exe' })),
}))

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}))

function createMockProc(pid: number) {
  const callbacks: Record<string, ((...args: unknown[]) => void)[]> = {}
  const stdoutCallbacks: Record<string, ((...args: unknown[]) => void)[]> = {}
  const stderrCallbacks: Record<string, ((...args: unknown[]) => void)[]> = {}
  const on = (event: string, cb: (...args: unknown[]) => void) => {
    callbacks[event] = callbacks[event] ?? []
    callbacks[event].push(cb)
  }
  const makeEmitter = (store: Record<string, ((...args: unknown[]) => void)[]>) => ({
    on: (event: string, cb: (...args: unknown[]) => void) => {
      store[event] = store[event] ?? []
      store[event].push(cb)
    },
    emit: (event: string, ...args: unknown[]) => {
      for (const cb of store[event] ?? []) cb(...args)
    },
  })
  const stdout = makeEmitter(stdoutCallbacks)
  const stderr = makeEmitter(stderrCallbacks)
  return {
    pid,
    stdout,
    stderr,
    on,
    emit: (event: string, ...args: unknown[]) => {
      // Backward compatibility: proc-level 'data' events feed stdout only so existing
      // tests do not need to distinguish the two streams.
      if (event === 'data') {
        stdout.emit('data', ...args)
        return
      }
      for (const cb of callbacks[event] ?? []) cb(...args)
    },
  }
}

describe('kimi-runner', () => {
  it('builds v24 analyze args with stream-json and native continuation', () => {
    expect(buildKimiArgs({ prompt: 'scan', continueLast: true })).toEqual([
      '-p',
      'scan',
      '--output-format',
      'stream-json',
      '-C',
    ])
  })

  it('does not pass deprecated or prompt-incompatible flags', () => {
    const args = buildKimiArgs({ prompt: 'scan', continueLast: true })
    expect(args).not.toContain('--print')
    expect(args).not.toContain('--final-message-only')
    expect(args).not.toContain('-w')
    expect(args).not.toContain('--no-thinking')
    expect(args).not.toContain('--auto')
    expect(args).not.toContain('-y')
    expect(args).not.toContain('--plan')
  })

  it('omits --plan for all edit values because it is incompatible with -p', () => {
    expect(buildKimiArgs({ prompt: 'scan' })).not.toContain('--plan')
    expect(buildKimiArgs({ prompt: 'scan', edit: false })).not.toContain('--plan')
    expect(buildKimiArgs({ prompt: 'scan', edit: true })).not.toContain('--plan')
  })

  it('uses explicit -S instead of -C when session id is provided', () => {
    expect(buildKimiArgs({ prompt: 'continue', sessionId: 'session_123', continueLast: true })).toContain('-S')
    expect(buildKimiArgs({ prompt: 'continue', sessionId: 'session_123', continueLast: true })).not.toContain('-C')
  })

  it('produces identical argv for edit:true and edit:false', () => {
    expect(buildKimiArgs({ prompt: 'scan', edit: true }))
      .toEqual(buildKimiArgs({ prompt: 'scan', edit: false }))
  })
})

describe('applyReadOnlyGuard', () => {
  it('returns the prompt unchanged when edit is true', () => {
    expect(applyReadOnlyGuard('analyze this', true)).toBe('analyze this')
  })

  it('prepends the read-only guard when edit is false or omitted', () => {
    const withFalse = applyReadOnlyGuard('analyze this', false)
    expect(withFalse.startsWith('[READ-ONLY ANALYSIS MODE]')).toBe(true)
    expect(withFalse).toContain('analyze this')

    const withUndefined = applyReadOnlyGuard('analyze this', undefined)
    expect(withUndefined.startsWith('[READ-ONLY ANALYSIS MODE]')).toBe(true)
  })
})

describe('runKimi timeout lifecycle', () => {
  it('clamps a zero timeout to the default and keeps the promise pending until close', async () => {
    const raw = [
      '{"role":"assistant","content":"draft"}',
      '{"role":"meta","type":"session.resume_hint","session_id":"session_abc"}',
      '{"role":"assistant","content":[{"type":"text","text":"final"}]}',
    ].join('\n')
    expect(parseKimiStreamJson(raw)).toEqual({ text: 'final', sessionId: 'session_abc' })
  })

  it('tolerates leading whitespace in JSONL records', () => {
    const raw = '   {"role":"assistant","content":"leading spaces"}\n\t{"role":"assistant","content":"tab"}'
    expect(parseKimiStreamJson(raw)).toEqual({ text: 'tab' })
  })

  it('keeps placeholders for non-text content parts', () => {
    const raw = '{"role":"assistant","content":[{"type":"image"},{"type":"tool_result"},{"type":"unknown"},{"type":"text","text":"ok"}]}'
    expect(parseKimiStreamJson(raw)).toEqual({ text: '[image][tool_result][unknown]ok' })
  })

  it('extracts session id from meta records even when type marker differs', () => {
    const raw = '{"role":"meta","type":"session.resumeHint","session_id":"session_fuzzy"}'
    expect(parseKimiStreamJson(raw)).toEqual({ text: '(empty response from Kimi)', sessionId: 'session_fuzzy' })
  })

  it('truncates at a clean boundary', () => {
    const text = `## A\n${'x'.repeat(100)}\n\n## B\n${'y'.repeat(100)}`
    const truncated = truncateAtBoundary(text, 80)
    expect(truncated).toContain('Output truncated')
    expect(truncated.length).toBeLessThan(text.length)
  })

  it('appendCapped returns full concatenation when under limit', () => {
    expect(appendCapped('hello ', 'world', 100)).toBe('hello world')
  })

  it('appendCapped truncates to exactly max when over limit', () => {
    const result = appendCapped('aaaa', 'bbbb', 6)
    expect(result).toBe('aaaabb')
    expect(result.length).toBe(6)
  })

  it('appendCapped ignores addition when current already at limit', () => {
    const current = 'x'.repeat(10)
    expect(appendCapped(current, 'more', 10)).toBe(current)
  })
})

describe('runKimi timeout lifecycle', () => {
  it('clamps a zero timeout to the default and keeps the promise pending until close', async () => {
    vi.useFakeTimers()
    let mockProc: ReturnType<typeof createMockProc>
    vi.mocked(spawn).mockImplementation((_cmd, args) => {
      if (Array.isArray(args) && args.includes('stream-json')) {
        mockProc = createMockProc(123)
        return mockProc as unknown as ReturnType<typeof spawn>
      }
      return createMockProc(999) as unknown as ReturnType<typeof spawn>
    })

    const { runKimi } = await import('./kimi-runner.js')
    const resultPromise = runKimi({ prompt: 'hello', timeoutMs: 0 })

    vi.advanceTimersByTime(1)
    expect(vi.mocked(spawn).mock.calls.filter((call) => call[0] === 'taskkill')).toHaveLength(0)

    vi.advanceTimersByTime(300_000)
    const taskkillCall = vi.mocked(spawn).mock.calls.find((call) => call[0] === 'taskkill')
    expect(taskkillCall).toEqual(['taskkill', ['/PID', '123', '/T', '/F'], expect.objectContaining({ stdio: 'ignore', windowsHide: true })])

    mockProc!.emit('close', 1)
    const result = await resultPromise
    expect(result.error).toContain('timed out')

    vi.useRealTimers()
  })
})

describe('runKimi progress reporting', () => {
  it('emits coalesced message progress from stream-json chunks', async () => {
    let mockProc: ReturnType<typeof createMockProc>
    vi.mocked(spawn).mockImplementation((_cmd, args) => {
      if (Array.isArray(args) && args.includes('stream-json')) {
        mockProc = createMockProc(123)
        return mockProc as unknown as ReturnType<typeof spawn>
      }
      return createMockProc(999) as unknown as ReturnType<typeof spawn>
    })

    const { runKimi } = await import('./kimi-runner.js')
    const events: ProgressEvent[] = []
    const resultPromise = runKimi({ prompt: 'hello', onProgress: (e) => events.push(e) })

    // Emit enough text to produce a truncated preview on flush.
    const chunk1 = 'x'.repeat(200)
    const chunk2 = 'y'.repeat(210)
    mockProc!.emit('data', Buffer.from(`{"role":"assistant","content":"${chunk1}"}\n`))
    mockProc!.emit('data', Buffer.from(`{"role":"assistant","content":"${chunk2}"}\n`))

    mockProc!.emit('close', 0)
    const result = await resultPromise

    expect(result.ok).toBe(true)
    const messageEvents = events.filter((e) => e.kind === 'message')
    expect(messageEvents.length).toBeGreaterThanOrEqual(1)
    expect(messageEvents[0].text).not.toContain('chars')
    expect(messageEvents[0].text).toContain('y')
  })

  it('emits immediate tool_call progress events from assistant tool_calls records', async () => {
    let mockProc: ReturnType<typeof createMockProc>
    vi.mocked(spawn).mockImplementation((_cmd, args) => {
      if (Array.isArray(args) && args.includes('stream-json')) {
        mockProc = createMockProc(123)
        return mockProc as unknown as ReturnType<typeof spawn>
      }
      return createMockProc(999) as unknown as ReturnType<typeof spawn>
    })

    const { runKimi } = await import('./kimi-runner.js')
    const events: ProgressEvent[] = []
    const resultPromise = runKimi({ prompt: 'hello', onProgress: (e) => events.push(e) })

    mockProc!.emit('data', Buffer.from(`${JSON.stringify({
      role: 'assistant',
      content: 'Working on it...',
      tool_calls: [
        { type: 'function', id: 't1', function: { name: 'Read', arguments: '{"path":"src/index.ts"}' } },
        { type: 'function', id: 't2', function: { name: 'Edit', arguments: '{"path":"src/types.ts"}' } },
      ],
    })}\n`))

    mockProc!.emit('close', 0)
    const result = await resultPromise

    expect(result.ok).toBe(true)
    const toolEvents = events.filter((e) => e.kind === 'tool_call')
    expect(toolEvents).toHaveLength(2)
    expect(toolEvents[0].text).toBe('Read src/index.ts')
    expect(toolEvents[1].text).toBe('Edit src/types.ts')
  })

  it('emits a todo event when a role:tool result contains a TodoList snapshot', async () => {
    let mockProc: ReturnType<typeof createMockProc>
    vi.mocked(spawn).mockImplementation((_cmd, args) => {
      if (Array.isArray(args) && args.includes('stream-json')) {
        mockProc = createMockProc(123)
        return mockProc as unknown as ReturnType<typeof spawn>
      }
      return createMockProc(999) as unknown as ReturnType<typeof spawn>
    })

    const { runKimi } = await import('./kimi-runner.js')
    const events: ProgressEvent[] = []
    const resultPromise = runKimi({ prompt: 'hello', onProgress: (e) => events.push(e) })

    mockProc!.emit('data', Buffer.from(`${JSON.stringify({
      role: 'tool',
      content: 'Todo list updated.\nCurrent todo list:\n  [done] Plan\n  [in_progress] Implement\n  [pending] Test\n\nEnsure that you continue to use the todo list.',
    })}
`))

    mockProc!.emit('close', 0)
    const result = await resultPromise

    expect(result.ok).toBe(true)
    const todoEvents = events.filter((e) => e.kind === 'todo')
    expect(todoEvents).toHaveLength(1)
    expect(todoEvents[0].text).toBe('TODO 1/3 ✓·· · now: Implement')
    expect(todoEvents[0].metadata?.todoFullList).toContain('[done] Plan')
    expect(todoEvents[0].metadata?.todoFullList).toContain('[in_progress] Implement')
  })

  it('ignores malformed and non-JSON lines without throwing', async () => {
    let mockProc: ReturnType<typeof createMockProc>
    vi.mocked(spawn).mockImplementation((_cmd, args) => {
      if (Array.isArray(args) && args.includes('stream-json')) {
        mockProc = createMockProc(123)
        return mockProc as unknown as ReturnType<typeof spawn>
      }
      return createMockProc(999) as unknown as ReturnType<typeof spawn>
    })

    const { runKimi } = await import('./kimi-runner.js')
    const events: ProgressEvent[] = []
    const resultPromise = runKimi({ prompt: 'hello', onProgress: (e) => events.push(e) })

    mockProc!.emit('data', Buffer.from('not json at all\n'))
    mockProc!.emit('data', Buffer.from('{invalid json}\n'))
    mockProc!.emit('data', Buffer.from('{"role":"unknown","content":"ignored"}\n'))
    mockProc!.emit('data', Buffer.from(`{"role":"assistant","content":"ok"}\n`))

    mockProc!.emit('close', 0)
    const result = await resultPromise

    expect(result.ok).toBe(true)
    expect(events.some((e) => e.kind === 'tool_call')).toBe(false)
    expect(events.some((e) => e.kind === 'message' && e.text === 'ok')).toBe(true)
  })

  it('does not create a stall watchdog in CLI mode, avoiding false positives during long silent work', async () => {
    vi.useFakeTimers()
    let mockProc: ReturnType<typeof createMockProc>
    vi.mocked(spawn).mockImplementation((_cmd, args) => {
      if (Array.isArray(args) && args.includes('stream-json')) {
        mockProc = createMockProc(123)
        return mockProc as unknown as ReturnType<typeof spawn>
      }
      return createMockProc(999) as unknown as ReturnType<typeof spawn>
    })

    const { runKimi } = await import('./kimi-runner.js')
    const events: ProgressEvent[] = []
    const resultPromise = runKimi({ prompt: 'hello', onProgress: (e) => events.push(e) })

    mockProc!.emit('close', 0)
    await resultPromise

    vi.advanceTimersByTime(35_000)
    expect(events.some((e) => e.kind === 'stall')).toBe(false)

    vi.useRealTimers()
  })

  it('preserves both stderr and stdout labelled when the process exits non-zero', async () => {
    let mockProc: ReturnType<typeof createMockProc>
    vi.mocked(spawn).mockImplementation((_cmd, args) => {
      if (Array.isArray(args) && args.includes('stream-json')) {
        mockProc = createMockProc(123)
        return mockProc as unknown as ReturnType<typeof spawn>
      }
      return createMockProc(999) as unknown as ReturnType<typeof spawn>
    })

    const { runKimi } = await import('./kimi-runner.js')
    const resultPromise = runKimi({ prompt: 'hello' })

    mockProc!.stdout.emit('data', Buffer.from('stdout content'))
    mockProc!.stderr.emit('data', Buffer.from('stderr content'))
    mockProc!.emit('close', 1)

    const result = await resultPromise
    expect(result.ok).toBe(false)
    expect(result.error).toContain('kimi exited with code 1')
    expect(result.error).toContain('stderr: stderr content')
    expect(result.error).toContain('stdout: stdout content')
  })
})

describe('runKimi cancellation', () => {
  it('resolves cancelled immediately when the signal is already aborted', async () => {
    vi.mocked(spawn).mockImplementation(() => createMockProc(999) as unknown as ReturnType<typeof spawn>)

    const { runKimi } = await import('./kimi-runner.js')
    const controller = new AbortController()
    controller.abort()

    const callsBefore = vi.mocked(spawn).mock.calls.length
    const result = await runKimi({ prompt: 'hello', signal: controller.signal })
    const callsAfter = vi.mocked(spawn).mock.calls.length

    expect(result.ok).toBe(false)
    expect(result.error?.toLowerCase()).toContain('cancel')
    expect(callsAfter - callsBefore).toBe(0)
  })

  it('kills the process and resolves cancelled when the signal aborts mid-run', async () => {
    let mockProc: ReturnType<typeof createMockProc>
    vi.mocked(spawn).mockImplementation((_cmd, args) => {
      if (Array.isArray(args) && args.includes('stream-json')) {
        mockProc = createMockProc(123)
        return mockProc as unknown as ReturnType<typeof spawn>
      }
      return createMockProc(999) as unknown as ReturnType<typeof spawn>
    })

    const { runKimi } = await import('./kimi-runner.js')
    const controller = new AbortController()
    const resultPromise = runKimi({ prompt: 'hello', signal: controller.signal })

    controller.abort()

    const result = await resultPromise
    expect(result.ok).toBe(false)
    expect(result.error?.toLowerCase()).toContain('cancel')

    const taskkillCall = vi.mocked(spawn).mock.calls.find((call) => call[0] === 'taskkill')
    expect(taskkillCall).toEqual(['taskkill', ['/PID', '123', '/T', '/F'], expect.objectContaining({ stdio: 'ignore', windowsHide: true })])
  })
})
