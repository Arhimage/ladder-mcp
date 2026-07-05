import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runMinimaxCode } from './minimax-code.js'
import type { MinimaxCodeDeps } from './minimax-code.js'
import type { MinimaxSession } from './minimax-session.js'

describe('runMinimaxCode', () => {
  const fakeSession: MinimaxSession = {
    id: 'minimax_session_00000000-0000-0000-0000-000000000000',
    provider: 'minimax',
    workDir: 'C:\\project',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    messages: [],
  }

  let savedSessions: MinimaxSession[] = []
  let writtenFiles: Array<{ path: string; content: string }> = []
  let deletedFiles: string[] = []

  function makeDeps(overrides: Partial<MinimaxCodeDeps> = {}): MinimaxCodeDeps {
    return {
      findMmxOnPath: vi.fn().mockReturnValue('C:\\bin\\mmx.exe'),
      runMmxCommand: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
      executeMinimaxTool: vi.fn().mockResolvedValue({ ok: true, output: 'tool done' }),
      createMinimaxSession: vi.fn().mockResolvedValue(fakeSession),
      loadMinimaxSession: vi.fn().mockResolvedValue({ ok: true, session: fakeSession }),
      saveMinimaxSession: vi.fn().mockImplementation((session: MinimaxSession) => {
        savedSessions.push(JSON.parse(JSON.stringify(session)) as MinimaxSession)
        return Promise.resolve()
      }),
      acquireMinimaxSessionLock: vi.fn().mockReturnValue(() => {}),
      tmpdir: vi.fn().mockReturnValue('C:\\temp'),
      writeFile: vi.fn().mockImplementation((filePath: string, content: string) => {
        writtenFiles.push({ path: filePath, content })
        return Promise.resolve()
      }),
      unlink: vi.fn().mockImplementation((filePath: string) => {
        deletedFiles.push(filePath)
        return Promise.resolve()
      }),
      ...overrides,
    }
  }

  beforeEach(() => {
    savedSessions = []
    writtenFiles = []
    deletedFiles = []
  })

  it('returns an error when mmx is not on PATH', async () => {
    const deps = makeDeps({ findMmxOnPath: vi.fn().mockReturnValue(undefined) })
    const result = await runMinimaxCode({ prompt: 'hello', workDir: 'C:\\project' }, deps)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('mmx')
    expect(result.error).toContain('PATH')
  })

  it('creates a session, sends a wrapped prompt, and returns final text', async () => {
    const deps = makeDeps({
      runMmxCommand: vi.fn().mockResolvedValue({
        stdout: JSON.stringify({ content: [{ type: 'text', text: 'final answer' }] }),
        stderr: '',
      }),
    })
    const result = await runMinimaxCode({ prompt: 'hello', workDir: 'C:\\project' }, deps)
    expect(result.ok).toBe(true)
    expect(result.text).toBe('final answer')
    expect(result.sessionId).toBe(fakeSession.id)
    expect(deps.createMinimaxSession).toHaveBeenCalledWith('C:\\project')
    expect(writtenFiles.length).toBe(1)
    expect(writtenFiles[0].path).toContain('C:\\temp')
    expect(writtenFiles[0].path).toContain(fakeSession.id)
    const messages = JSON.parse(writtenFiles[0].content) as unknown[]
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ role: 'user' })
    expect(JSON.stringify(messages[0])).toContain('hello')
    expect(deletedFiles).toContain(writtenFiles[0].path)
    expect(savedSessions.length).toBeGreaterThanOrEqual(1)
  })

  it('uses --messages-file and --tool arguments with expected flags', async () => {
    const deps = makeDeps({
      runMmxCommand: vi.fn().mockResolvedValue({
        stdout: JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }),
        stderr: '',
      }),
    })
    await runMinimaxCode({ prompt: 'do work', workDir: 'C:\\project', edit: true }, deps)
    const call = vi.mocked(deps.runMmxCommand!).mock.calls[0]!
    expect(call[0]).toBe('C:\\bin\\mmx.exe')
    const args = call[1] as string[]
    expect(args).toContain('text')
    expect(args).toContain('chat')
    expect(args).toContain('--messages-file')
    expect(args).toContain('--output')
    expect(args).toContain('json')
    expect(args).toContain('--non-interactive')
    expect(args).toContain('--no-color')
    expect(args).toContain('--timeout')
    expect(args).toContain('--tool')
    const messagesFile = args[args.indexOf('--messages-file') + 1]
    expect(deletedFiles).toContain(messagesFile)
  })

  it('executes tool_use blocks and appends tool_result messages', async () => {
    const deps = makeDeps({
      runMmxCommand: vi.fn()
        .mockResolvedValueOnce({
          stdout: JSON.stringify({
            content: [
              { type: 'text', text: 'I will read' },
              { type: 'tool_use', id: 'tu_1', name: 'read_text_file', input: { path: 'file.txt' } },
            ],
          }),
          stderr: '',
        })
        .mockResolvedValueOnce({
          stdout: JSON.stringify({ content: [{ type: 'text', text: 'done' }] }),
          stderr: '',
        }),
      executeMinimaxTool: vi.fn().mockResolvedValue({ ok: true, output: 'file contents' }),
    })
    const result = await runMinimaxCode({ prompt: 'read file', workDir: 'C:\\project' }, deps)
    expect(result.ok).toBe(true)
    expect(result.text).toBe('done')
    expect(deps.executeMinimaxTool).toHaveBeenCalledWith(
      expect.objectContaining({ workDir: 'C:\\project', edit: false, tool: { id: 'tu_1', name: 'read_text_file', input: { path: 'file.txt' } } }),
    )
    const messagesWithToolResult = savedSessions.find((s) =>
      (s.messages[s.messages.length - 1].content as Array<{ type: string }>).some((b) => b.type === 'tool_result'),
    )
    expect(messagesWithToolResult).toBeDefined()
  })

  it('returns resumable=true when iteration limit is reached', async () => {
    const deps = makeDeps({
      runMmxCommand: vi.fn().mockResolvedValue({
        stdout: JSON.stringify({
          content: [
            { type: 'text', text: 'I will read' },
            { type: 'tool_use', id: `tu_1`, name: 'read_text_file', input: { path: 'file.txt' } },
          ],
        }),
        stderr: '',
      }),
      executeMinimaxTool: vi.fn().mockResolvedValue({ ok: true, output: 'more' }),
    })
    const result = await runMinimaxCode({ prompt: 'loop', workDir: 'C:\\project' }, deps)
    expect(result.ok).toBe(false)
    expect(result.resumable).toBe(true)
    expect(result.sessionId).toBe(fakeSession.id)
    expect(result.error).toContain('maximum 20 iterations')
  })

  it('loads an existing session when session_id is provided', async () => {
    const deps = makeDeps({
      runMmxCommand: vi.fn().mockResolvedValue({
        stdout: JSON.stringify({ content: [{ type: 'text', text: 'continued' }] }),
        stderr: '',
      }),
    })
    const result = await runMinimaxCode({ prompt: 'continue', workDir: 'C:\\project', sessionId: fakeSession.id }, deps)
    expect(result.ok).toBe(true)
    expect(deps.loadMinimaxSession).toHaveBeenCalledWith(fakeSession.id, { workDir: 'C:\\project' })
    expect(deps.createMinimaxSession).not.toHaveBeenCalled()
  })

  it('returns an error when the response is empty and has no tool_use blocks', async () => {
    const deps = makeDeps({
      runMmxCommand: vi.fn().mockResolvedValue({
        stdout: JSON.stringify({ content: [] }),
        stderr: '',
      }),
    })
    const result = await runMinimaxCode({ prompt: 'hello', workDir: 'C:\\project' }, deps)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('MiniMax returned an empty answer.')
    expect(result.sessionId).toBe(fakeSession.id)
  })

  it('returns an error when the session is already locked', async () => {
    const deps = makeDeps({ acquireMinimaxSessionLock: vi.fn().mockReturnValue(undefined) })
    const result = await runMinimaxCode({ prompt: 'hello', workDir: 'C:\\project' }, deps)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('locked')
  })

  it('releases the lock even on failure', async () => {
    const release = vi.fn()
    const deps = makeDeps({
      runMmxCommand: vi.fn().mockRejectedValue(new Error('mmx crashed')),
      acquireMinimaxSessionLock: vi.fn().mockReturnValue(release),
    })
    await runMinimaxCode({ prompt: 'hello', workDir: 'C:\\project' }, deps)
    expect(release).toHaveBeenCalled()
  })
})
