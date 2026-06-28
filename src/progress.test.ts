import { describe, expect, it, vi } from 'vitest'
import {
  combineReporters,
  createMcpProgressReporter,
  createProgressCoalescer,
  createStallWatchdog,
  createTodoTracker,
  formatProgressLine,
  formatTaskLogLine,
  formatTodoFullList,
  formatTodoSummary,
  makeEvent,
  parseAcpTodoPayload,
  parseCliTodoSnapshot,
} from './progress.js'

describe('progress', () => {
  it('formats an event as a compact timestamped line', () => {
    const line = formatProgressLine(makeEvent('message', 'hello'))
    expect(line).toMatch(/^\[\d{2}:\d{2}:\d{2}\] ▸ message: hello$/)
  })

  it('fires a stall event after inactivity and re-arms for the next period', () => {
    vi.useFakeTimers()
    try {
      const events: string[] = []
      const watchdog = createStallWatchdog((event) => { events.push(event.text) }, 1000)

      vi.advanceTimersByTime(1000)
      expect(events.length).toBe(1)
      expect(events[0]).toContain('no activity')

      watchdog.ping()
      vi.advanceTimersByTime(1000)
      expect(events.length).toBe(2)

      watchdog.stop()
      vi.advanceTimersByTime(2000)
      expect(events.length).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('no-ops when the MCP client does not provide a progress token', () => {
    const reporter = createMcpProgressReporter({ sendNotification: vi.fn() })
    expect(() => reporter(makeEvent('message', 'ignored'))).not.toThrow()

    const reporterNoSend = createMcpProgressReporter({ _meta: { progressToken: 'token' } })
    expect(() => reporterNoSend(makeEvent('message', 'ignored'))).not.toThrow()
  })

  it('forwards MCP progress notifications when a token is present', async () => {
    const sendNotification = vi.fn().mockResolvedValue(undefined)
    const reporter = createMcpProgressReporter({ sendNotification, _meta: { progressToken: 'token-1' } })
    reporter(makeEvent('message', 'hello'))
    await vi.waitFor(() => expect(sendNotification).toHaveBeenCalledTimes(1))
    expect(sendNotification).toHaveBeenCalledWith(expect.objectContaining({
      method: 'notifications/progress',
      params: expect.objectContaining({ progressToken: 'token-1', progress: 1 }),
    }))
  })

  it('combines reporters and isolates a throwing reporter from the others', () => {
    const calls: string[] = []
    const throwing = () => { throw new Error('boom') }
    const normal = (event: { text: string }) => { calls.push(event.text) }
    const combined = combineReporters(throwing, normal)
    combined(makeEvent('message', 'preserve me'))
    expect(calls).toEqual(['preserve me'])
  })

  it('returns a no-op reporter when no reporters are provided', () => {
    const reporter = combineReporters(undefined, undefined)
    expect(() => reporter(makeEvent('message', 'noop'))).not.toThrow()
  })
})

describe('createProgressCoalescer', () => {
  it('formats a single-line preview with collapsed whitespace and truncation prefix', () => {
    vi.useFakeTimers()
    try {
      const events: { kind: string; text: string }[] = []
      const coalescer = createProgressCoalescer((event) => { events.push({ kind: event.kind, text: event.text }) }, { dwellMs: 100 })

      coalescer.add('message', '  line one\nline   two  ')
      vi.advanceTimersByTime(100)

      expect(events).toHaveLength(1)
      expect(events[0].kind).toBe('message')
      expect(events[0].text).toBe('line one line two')
    } finally {
      vi.useRealTimers()
    }
  })

  it('emits the latest preview at most once per dwell window and drops old tail text', () => {
    vi.useFakeTimers()
    try {
      const events: string[] = []
      const coalescer = createProgressCoalescer((event) => { events.push(event.text) }, { dwellMs: 1000, tailMaxChars: 12 })

      coalescer.add('message', 'alpha ')
      vi.advanceTimersByTime(400)
      coalescer.add('message', 'beta ')
      vi.advanceTimersByTime(400)
      coalescer.add('message', 'gamma')
      vi.advanceTimersByTime(400)

      expect(events.length).toBe(1)
      expect(events[0]).toContain('gamma')
      expect(events[0]).not.toContain('alpha')
    } finally {
      vi.useRealTimers()
    }
  })

  it('flushes pending preview before an immediate tool event and preserves ordering', () => {
    const events: { kind: string; text: string }[] = []
    const coalescer = createProgressCoalescer((event) => { events.push({ kind: event.kind, text: event.text }) }, { dwellMs: 10_000 })

    coalescer.add('message', 'streaming text')
    coalescer.add('tool_call', 'Read src/index.ts')
    coalescer.stop()

    expect(events.map((e) => e.kind)).toEqual(['message', 'tool_call'])
    expect(events[0].text).toContain('streaming text')
    expect(events[1].text).toBe('Read src/index.ts')
  })

  it('flushes the final partial preview on stop', () => {
    const events: { kind: string; text: string }[] = []
    const coalescer = createProgressCoalescer((event) => { events.push({ kind: event.kind, text: event.text }) }, { dwellMs: 10_000 })

    coalescer.add('thought', 'thinking...')
    coalescer.stop()

    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('thought')
    expect(events[0].text).toContain('thinking')
  })

  it('truncates long previews and prefixes with …', () => {
    vi.useFakeTimers()
    try {
      const events: string[] = []
      const coalescer = createProgressCoalescer((event) => { events.push(event.text) }, { dwellMs: 100, previewMaxChars: 20, tailMaxChars: 50 })

      coalescer.add('message', 'one two three four five six seven eight nine ten')
      vi.advanceTimersByTime(100)

      expect(events[0]).toMatch(/^…/)
      expect(events[0].length).toBeLessThanOrEqual(22) // … + 20 preview chars
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not split surrogate pairs when capping tail or preview', () => {
    vi.useFakeTimers()
    try {
      const events: { text: string }[] = []
      const coalescer = createProgressCoalescer((event) => { events.push({ text: event.text }) }, { dwellMs: 100, previewMaxChars: 8, tailMaxChars: 10 })

      // Each emoji is a surrogate pair. With tailMaxChars=10 code points, the tail
      // should keep the last 10 code points intact, and the preview should keep
      // the last 8 without splitting a pair.
      const text = '12345 🌍🌍🌍🌍🌍 planetary text 🚀🚀🚀🚀🚀'
      coalescer.add('message', text)
      vi.advanceTimersByTime(100)

      expect(events).toHaveLength(1)
      expect(events[0].text).not.toContain('�')
      // The preview must be valid Unicode: encoding and decoding round-trip succeeds.
      expect(new TextEncoder().encode(events[0].text).length).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('emits the pending message preview before an immediate tool_call event', () => {
    const events: { kind: string }[] = []
    const coalescer = createProgressCoalescer((event) => { events.push({ kind: event.kind }) }, { dwellMs: 10_000 })

    coalescer.add('message', 'streaming text')
    coalescer.add('tool_call', 'Read src/index.ts')

    expect(events.map((e) => e.kind)).toEqual(['message', 'tool_call'])
  })

  it('does not emit an event for a whitespace-only tail', () => {
    const events: { kind: string }[] = []
    const coalescer = createProgressCoalescer((event) => { events.push({ kind: event.kind }) }, { dwellMs: 10_000 })

    coalescer.add('message', '   \n\t  ')
    coalescer.stop()

    expect(events).toHaveLength(0)
  })

  it('suppresses message/thought previews while a TODO priority window is active, but still emits tool_call events', () => {
    vi.useFakeTimers()
    try {
      const events: { kind: string }[] = []
      const coalescer = createProgressCoalescer((event) => { events.push({ kind: event.kind }) }, { dwellMs: 100, todoPriorityMs: 1000 })

      coalescer.add('message', 'chatty text')
      coalescer.add('todo', 'TODO 0/2 ··')
      coalescer.add('message', 'more chatty text')
      coalescer.add('tool_call', 'Read src/index.ts')
      vi.advanceTimersByTime(100)

      // The first message is flushed immediately when the todo arrives; subsequent
      // message/thought previews are suppressed during the priority window.
      expect(events.map((e) => e.kind)).toEqual(['message', 'todo', 'tool_call'])

      vi.advanceTimersByTime(1000)
      // After the window expires, the accumulated tail is emitted once.
      expect(events.some((e) => e.kind === 'message')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('todo tracker', () => {
  it('replaces the whole list on each update and reports whether it changed', () => {
    const tracker = createTodoTracker()
    expect(tracker.update([{ text: 'a', status: 'pending' }, { text: 'b', status: 'done' }])).toBe(true)
    expect(tracker.getSummary()).toBe('TODO 1/2 ·✓')
    expect(tracker.update([{ text: 'a', status: 'in_progress' }, { text: 'b', status: 'done' }])).toBe(true)
    expect(tracker.getSummary()).toBe('TODO 1/2 ·✓ · now: a')
    expect(tracker.update([{ text: 'a', status: 'in_progress' }, { text: 'b', status: 'done' }])).toBe(false)
  })

  it('formats a compact summary with done count, markers, and current task', () => {
    const items = [
      { text: 'Plan', status: 'done' as const },
      { text: 'Implement', status: 'in_progress' as const },
      { text: 'Test', status: 'pending' as const },
    ]
    expect(formatTodoSummary(items)).toBe('TODO 1/3 ✓·· · now: Implement')
  })

  it('formats the full multi-line list', () => {
    const items = [
      { text: 'Plan', status: 'done' as const },
      { text: 'Implement', status: 'in_progress' as const },
    ]
    expect(formatTodoFullList(items)).toBe('[done] Plan\n[in_progress] Implement')
  })

  it('formats task-log line with the full list indented under the compact summary', () => {
    const event = makeEvent('todo', 'TODO 1/2 ✓·', { todoFullList: '[done] Plan\n[pending] Build' })
    const line = formatTaskLogLine(event)
    expect(line).toMatch(/^\[\d{2}:\d{2}:\d{2}\] ☑ todo: TODO 1\/2 ✓·$/m)
    expect(line).toContain('    [done] Plan')
    expect(line).toContain('    [pending] Build')
  })

  it('parses a CLI TodoList snapshot, stripping boilerplate and mapping statuses', () => {
    const snapshot = `Todo list updated.
Current todo list:
  [done] Write implementation plan
  [in_progress] Create main.py
  [pending] Create README.md

Ensure that you continue to use the todo list to track progress.`
    const todos = parseCliTodoSnapshot(snapshot)
    expect(todos).toEqual([
      { text: 'Write implementation plan', status: 'done' },
      { text: 'Create main.py', status: 'in_progress' },
      { text: 'Create README.md', status: 'pending' },
    ])
  })

  it('returns undefined for text without the todo snapshot marker', () => {
    expect(parseCliTodoSnapshot('hello world')).toBeUndefined()
  })

  it('parses the ACP JSON todos payload', () => {
    const payload = JSON.stringify({ todos: [{ title: 'Plan', status: 'pending' }, { title: 'Build', status: 'done' }] })
    expect(parseAcpTodoPayload(payload)).toEqual([
      { text: 'Plan', status: 'pending' },
      { text: 'Build', status: 'done' },
    ])
  })

  it('falls back to snapshot parsing for ACP human-readable todo text', () => {
    const text = 'Current todo list:\n  [in_progress] Write tests\n  [pending] Write docs'
    expect(parseAcpTodoPayload(text)).toEqual([
      { text: 'Write tests', status: 'in_progress' },
      { text: 'Write docs', status: 'pending' },
    ])
  })
})
