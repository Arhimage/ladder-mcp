import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { AcpClient, AcpMessageParser, clampTimeout, encodeAcpMessage, extractAcpText, resolveAcpTimeout, runAcpPrompt, ACP_TIMEOUT_FLOOR_MS } from './acp.js'
import type { ProgressEvent } from '../types.js'

vi.mock('../environment.js', () => ({
  buildKimiEnv: vi.fn(() => ({})),
  resolveKimiPaths: vi.fn(() => ({ binaryPath: 'kimi.exe' })),
}))

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('acp transport', () => {
  it('encodes JSON-RPC messages as newline-delimited JSON for Kimi ACP', () => {
    const encoded = encodeAcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }).toString('utf-8')
    expect(encoded.endsWith('\n')).toBe(true)
    expect(encoded).toContain('"method":"initialize"')
  })

  it('parses Content-Length framed messages incrementally for compatibility', () => {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }), 'utf-8')
    const message = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body])
    const parser = new AcpMessageParser()
    expect(parser.push(message.subarray(0, 10))).toEqual([])
    expect(parser.push(message.subarray(10))).toEqual([{ jsonrpc: '2.0', id: 1, result: { ok: true } }])
  })

  it('keeps partial Content-Length headers until the body arrives', () => {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { ok: true } }), 'utf-8')
    const parser = new AcpMessageParser()
    expect(parser.push(`Content-Length: ${body.length}\r\n`)).toEqual([])
    expect(parser.push(Buffer.concat([Buffer.from('\r\n'), body]))).toEqual([{ jsonrpc: '2.0', id: 2, result: { ok: true } }])
  })

  it('rejects malformed JSON frames instead of silently corrupting parser state', () => {
    const parser = new AcpMessageParser()
    expect(() => parser.push('{"jsonrpc":"2.0", bad}\n')).toThrow(/Malformed ACP JSON/)
  })

  it('rejects Content-Length frames without JSON-RPC 2.0 marker', () => {
    const body = Buffer.from(JSON.stringify({ id: 1, result: {} }), 'utf-8')
    const parser = new AcpMessageParser()
    expect(() => parser.push(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]))).toThrow(/JSON-RPC 2.0/)
  })

  it('ignores newline-delimited frames without JSON-RPC 2.0 marker', () => {
    const parser = new AcpMessageParser()
    expect(parser.push('{"id":1,"result":{}}\n')).toEqual([])
  })

  it('handles zero-length Content-Length frames', () => {
    const parser = new AcpMessageParser()
    expect(parser.push('Content-Length: 0\r\n\r\n{"jsonrpc":"2.0","id":3,"result":{}}\n')).toEqual([
      { jsonrpc: '2.0', id: 3, result: {} },
    ])
  })

  it('skips non-Content-Length header blocks instead of crashing', () => {
    const parser = new AcpMessageParser()
    expect(parser.push('Content-Type: application/json\r\n\r\n{"jsonrpc":"2.0","id":4,"result":{}}\n')).toEqual([
      { jsonrpc: '2.0', id: 4, result: {} },
    ])
  })

  it('also parses newline-delimited JSON fallback', () => {
    const parser = new AcpMessageParser()
    expect(parser.push('{"jsonrpc":"2.0","method":"session/update","params":{"text":"hi"}}\n')).toEqual([
      { jsonrpc: '2.0', method: 'session/update', params: { text: 'hi' } },
    ])
  })

  it('extracts text from nested ACP-ish payloads', () => {
    expect(extractAcpText({ updates: [{ content: [{ type: 'text', text: 'hello' }] }] })).toBe('hello')
  })

  it('preserves inter-token spaces across streamed chunks', () => {
    // Kimi streams a sentence as many small chunks with leading spaces; concatenating
    // them as-is must reproduce the spaces (regression for the "Twoplustwo" bug).
    expect(extractAcpText({ content: [{ text: 'Two' }, { text: ' plus' }, { text: ' two' }] })).toBe('Two plus two')
  })

  it('concatenates repeated text fragments without inserting separators', () => {
    expect(extractAcpText({ content: [{ text: 'ab' }, { text: 'cd' }] })).toBe('abcd')
  })

  it('does not treat protocol metadata as response text', () => {
    expect(extractAcpText({ stopReason: 'end_turn', sessionId: 'session_1' })).toBe('')
  })

  it('clamps non-positive or invalid timeouts to the fallback', () => {
    expect(clampTimeout(0, 120_000)).toBe(120_000)
    expect(clampTimeout(-5, 120_000)).toBe(120_000)
    expect(clampTimeout(Number.NaN, 120_000)).toBe(120_000)
    expect(clampTimeout(undefined, 120_000)).toBe(120_000)
    expect(clampTimeout(30_000, 120_000)).toBe(30_000)
  })

  it('resolves ACP prompt timeouts to the 30-minute floor', () => {
    expect(resolveAcpTimeout(undefined)).toBe(ACP_TIMEOUT_FLOOR_MS)
    expect(resolveAcpTimeout(30_000)).toBe(ACP_TIMEOUT_FLOOR_MS)
    expect(resolveAcpTimeout(3_600_000)).toBe(3_600_000)
  })
})

describe('acp bidirectional request handling', () => {
  function createMockClient() {
    const client = new AcpClient()
    const written: Buffer[] = []
    const mockProc = {
      stdin: {
        write: (chunk: Buffer, callback?: (error?: Error | null) => void) => {
          written.push(Buffer.from(chunk))
          callback?.(null)
          return true
        },
      },
      stderr: { on: () => {} },
      stdout: { on: () => {} },
      on: () => {},
      kill: () => {},
      killed: false,
    } as unknown as ReturnType<typeof import('node:child_process').spawn> & { stdin: { write: (chunk: Buffer, callback?: (error?: Error | null) => void) => boolean } }
    ;(client as unknown as { proc: typeof mockProc }).proc = mockProc
    return { client, mockProc, written, dispatch: (messages: unknown[]) => (client as unknown as { dispatch(messages: unknown[]): void }).dispatch(messages) }
  }

  async function flush() {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  it('routes responses to pending outbound requests and requests to the handler', async () => {
    const { client, written, dispatch } = createMockClient()

    const responsePromise = (client as unknown as { request(method: string, params?: unknown): Promise<unknown> }).request('session/new', { cwd: '/tmp' })
    const requestId = Number.parseInt(JSON.parse(written[0].toString('utf-8')).id as string, 10)
    expect(requestId).toBeGreaterThanOrEqual(1_000_000)

    dispatch([
      { jsonrpc: '2.0', id: requestId, result: { sessionId: 's1' } },
      { jsonrpc: '2.0', id: 0, method: 'session/request_permission', params: { sessionId: 's1', options: [{ optionId: 'approve_once', name: 'Approve once', kind: 'allow_once' }], toolCall: { toolCallId: 't1', title: 'Write' } } },
      { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'tool_call', toolCallId: 't1' } } },
    ])

    await expect(responsePromise).resolves.toEqual({ sessionId: 's1' })
    await flush()

    expect(written.length).toBe(2)
    const reply = JSON.parse(written[1].toString('utf-8'))
    expect(reply.id).toBe(0)
    expect(reply.result).toEqual({ outcome: { outcome: 'selected', optionId: 'approve_once' } })
  })

  it('emits notifications for inbound notifications and surfaces tool_call updates', async () => {
    const { client, dispatch } = createMockClient()
    const notifications: unknown[] = []
    client.on('notification', (message: unknown) => notifications.push(message))

    dispatch([
      { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } } } },
      { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Write', kind: 'edit', status: 'pending' } } },
      { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress', content: [{ type: 'content', content: { type: 'text', text: 'arg' } }] } } },
      { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'plan', entries: [{ content: 'step', priority: 'high', status: 'pending' }] } } },
    ])

    expect(notifications.length).toBe(4)
    expect(client.getUpdateText()).not.toContain('thinking')
    expect(client.getThinkingText()).toContain('thinking')
  })

  it('respond() writes a framed JSON-RPC reply for unknown methods', async () => {
    const { client, written, dispatch } = createMockClient()
    dispatch([{ jsonrpc: '2.0', id: 7, method: 'fs/unknown', params: { sessionId: 's1', path: '/x' } }])
    await flush()

    expect(written.length).toBe(1)
    const reply = JSON.parse(written[0].toString('utf-8'))
    expect(reply.jsonrpc).toBe('2.0')
    expect(reply.id).toBe(7)
    expect(reply.error?.code).toBe(-32601)
    expect(reply.error?.message).toContain('fs/unknown')
  })

  it('auto-approves session/request_permission with the allow_once option', async () => {
    const { client, written, dispatch } = createMockClient()
    dispatch([{
      jsonrpc: '2.0',
      id: 42,
      method: 'session/request_permission',
      params: {
        sessionId: 's1',
        options: [
          { optionId: 'approve_once', name: 'Approve once', kind: 'allow_once' },
          { optionId: 'approve_always', name: 'Always', kind: 'allow_always' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
        toolCall: { toolCallId: 't1', title: 'Write' },
      },
    }])
    await flush()

    const reply = JSON.parse(written[0].toString('utf-8'))
    expect(reply.id).toBe(42)
    expect(reply.result).toEqual({ outcome: { outcome: 'selected', optionId: 'approve_once' } })
  })

  it('proxies fs read/write within the session work directory', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-fs-test-'))
    const { client, written, dispatch } = createMockClient()
    client.workDir = tmpDir

    dispatch([{ jsonrpc: '2.0', id: 1, method: 'fs/write_text_file', params: { sessionId: 's1', path: 'nested/file.txt', content: 'hello acp' } }])
    await flush()

    let reply = JSON.parse(written[0].toString('utf-8'))
    expect(reply.id).toBe(1)
    expect(reply.result).toEqual({})
    expect(await fs.readFile(path.join(tmpDir, 'nested/file.txt'), 'utf-8')).toBe('hello acp')

    written.length = 0
    dispatch([{ jsonrpc: '2.0', id: 2, method: 'fs/read_text_file', params: { sessionId: 's1', path: 'nested/file.txt' } }])
    await flush()

    reply = JSON.parse(written[0].toString('utf-8'))
    expect(reply.id).toBe(2)
    expect(reply.result).toEqual({ content: 'hello acp' })

    written.length = 0
    dispatch([{ jsonrpc: '2.0', id: 3, method: 'fs/read_directory', params: { sessionId: 's1', path: 'nested' } }])
    await flush()

    reply = JSON.parse(written[0].toString('utf-8'))
    expect(reply.id).toBe(3)
    expect(reply.result?.entries).toContain('file.txt')

    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('rejects fs paths outside the session work directory', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-sandbox-test-'))
    const { client, written, dispatch } = createMockClient()
    client.workDir = tmpDir

    dispatch([{ jsonrpc: '2.0', id: 1, method: 'fs/write_text_file', params: { sessionId: 's1', path: '/etc/passwd', content: 'x' } }])
    await flush()

    let reply = JSON.parse(written[0].toString('utf-8'))
    expect(reply.id).toBe(1)
    expect(reply.error?.code).toBe(-32602)
    expect(reply.error?.message).toContain('outside session work directory')

    written.length = 0
    dispatch([{ jsonrpc: '2.0', id: 2, method: 'fs/read_text_file', params: { sessionId: 's1', path: '../outside.txt' } }])
    await flush()

    reply = JSON.parse(written[0].toString('utf-8'))
    expect(reply.id).toBe(2)
    expect(reply.error?.code).toBe(-32602)
    expect(reply.error?.message).toContain('outside session work directory')

    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('rejects fs requests when workDir is not set', async () => {
    const { client, written, dispatch } = createMockClient()
    dispatch([{ jsonrpc: '2.0', id: 1, method: 'fs/read_text_file', params: { sessionId: 's1', path: 'file.txt' } }])
    await flush()

    const reply = JSON.parse(written[0].toString('utf-8'))
    expect(reply.id).toBe(1)
    expect(reply.error?.code).toBe(-32602)
    expect(reply.error?.message).toContain('work directory is not set')
  })

  it('rejects empty, missing, and drive-relative paths', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-invalid-path-test-'))
    const { client, written, dispatch } = createMockClient()
    client.workDir = tmpDir

    dispatch([{ jsonrpc: '2.0', id: 1, method: 'fs/read_text_file', params: { sessionId: 's1', path: '' } }])
    await flush()
    let reply = JSON.parse(written[0].toString('utf-8'))
    expect(reply.error?.code).toBe(-32602)

    written.length = 0
    dispatch([{ jsonrpc: '2.0', id: 2, method: 'fs/read_text_file', params: { sessionId: 's1' } }])
    await flush()
    reply = JSON.parse(written[0].toString('utf-8'))
    expect(reply.error?.code).toBe(-32602)

    written.length = 0
    dispatch([{ jsonrpc: '2.0', id: 3, method: 'fs/read_text_file', params: { sessionId: 's1', path: 'C:foo' } }])
    await flush()
    reply = JSON.parse(written[0].toString('utf-8'))
    expect(reply.error?.code).toBe(-32602)
    expect(reply.error?.message).toContain('drive-relative')

    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('does not escape sandbox via case-folding siblings', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-case-test-'))
    const projectDir = path.join(base, 'Project')
    const siblingDir = path.join(base, 'project')
    await fs.mkdir(projectDir)
    try {
      await fs.mkdir(siblingDir)
    } catch (error) {
      // Filesystem is case-insensitive (common on Windows), so this vector does not apply.
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        await fs.rm(base, { recursive: true, force: true })
        return
      }
      throw error
    }
    await fs.writeFile(path.join(siblingDir, 'secret.txt'), 'secret')

    const { client, written, dispatch } = createMockClient()
    client.workDir = projectDir

    dispatch([{ jsonrpc: '2.0', id: 1, method: 'fs/read_text_file', params: { sessionId: 's1', path: '../project/secret.txt' } }])
    await flush()

    const reply = JSON.parse(written[0].toString('utf-8'))
    expect(reply.error?.code).toBe(-32602)
    expect(reply.error?.message).toContain('outside session work directory')

    await fs.rm(base, { recursive: true, force: true })
  })

  it('does not escape sandbox via symlinks or junctions', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-symlink-test-'))
    const workDir = path.join(base, 'work')
    const outsideDir = path.join(base, 'outside')
    await fs.mkdir(workDir)
    await fs.mkdir(outsideDir)
    await fs.writeFile(path.join(outsideDir, 'secret.txt'), 'secret')

    let linkCreated = false
    try {
      await fs.symlink(outsideDir, path.join(workDir, 'escape'), 'dir')
      linkCreated = true
    } catch {
      // Symlink creation may require privileges on Windows; skip this test if unavailable.
    }

    if (!linkCreated) {
      await fs.rm(base, { recursive: true, force: true })
      return
    }

    const { client, written, dispatch } = createMockClient()
    client.workDir = workDir

    dispatch([{ jsonrpc: '2.0', id: 1, method: 'fs/read_text_file', params: { sessionId: 's1', path: 'escape/secret.txt' } }])
    await flush()

    const reply = JSON.parse(written[0].toString('utf-8'))
    expect(reply.error?.code).toBe(-32602)
    expect(reply.error?.message).toContain('outside session work directory')

    await fs.rm(base, { recursive: true, force: true })
  })

  it('caps fs reads to MAX_FS_READ_BYTES', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-read-cap-test-'))
    const bigFile = path.join(tmpDir, 'big.txt')
    await fs.writeFile(bigFile, Buffer.alloc(9 * 1024 * 1024))

    const { client, written, dispatch } = createMockClient()
    client.workDir = tmpDir

    dispatch([{ jsonrpc: '2.0', id: 1, method: 'fs/read_text_file', params: { sessionId: 's1', path: 'big.txt' } }])
    await flush()

    const reply = JSON.parse(written[0].toString('utf-8'))
    expect(reply.error?.code).toBe(-32602)
    expect(reply.error?.message).toContain('maximum read size')

    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('rejects session/request_permission when no allow_once option exists', async () => {
    const { client, written, dispatch } = createMockClient()
    dispatch([{
      jsonrpc: '2.0',
      id: 42,
      method: 'session/request_permission',
      params: {
        sessionId: 's1',
        options: [
          { optionId: 'approve_always', name: 'Always', kind: 'allow_always' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
        toolCall: { toolCallId: 't1', title: 'Write' },
      },
    }])
    await flush()

    const reply = JSON.parse(written[0].toString('utf-8'))
    expect(reply.id).toBe(42)
    expect(reply.error?.code).toBe(-32602)
    expect(reply.error?.message).toContain('no allowed permission option')
  })

  it('keeps outbound request ids in a disjoint space so agent request ids do not collide', () => {
    const { client, written } = createMockClient()
    void (client as unknown as { request(method: string, params?: unknown): Promise<unknown> }).request('session/new', {})
    const requestId = JSON.parse(written[0].toString('utf-8')).id as number
    expect(requestId).toBeGreaterThanOrEqual(1_000_000)
  })

  describe('AcpClient read-only enforcement', () => {
    it('rejects fs write_text_file when allowWrite is false', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-ro-write-test-'))
      const { client, written, dispatch } = createMockClient()
      client.workDir = tmpDir
      client.allowWrite = false

      dispatch([{ jsonrpc: '2.0', id: 1, method: 'fs/write_text_file', params: { sessionId: 's1', path: 'nested/file.txt', content: 'hello acp' } }])
      await flush()

      const reply = JSON.parse(written[0].toString('utf-8'))
      expect(reply.id).toBe(1)
      expect(reply.error?.code).toBe(-32602)
      expect(reply.error?.message).toContain('read-only mode')
      await expect(fs.access(path.join(tmpDir, 'nested/file.txt'))).rejects.toThrow()
      await fs.rm(tmpDir, { recursive: true, force: true })
    })

    it('selects reject_once option for session/request_permission when allowWrite is false', async () => {
      const { client, written, dispatch } = createMockClient()
      client.allowWrite = false
      dispatch([{
        jsonrpc: '2.0',
        id: 42,
        method: 'session/request_permission',
        params: {
          sessionId: 's1',
          options: [
            { optionId: 'approve_once', name: 'Approve once', kind: 'allow_once' },
            { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
          ],
          toolCall: { toolCallId: 't1', title: 'Write' },
        },
      }])
      await flush()

      const reply = JSON.parse(written[0].toString('utf-8'))
      expect(reply.id).toBe(42)
      expect(reply.result).toEqual({ outcome: { outcome: 'selected', optionId: 'reject_once' } })
    })

    it('cancels session/request_permission when allowWrite is false and no reject option exists', async () => {
      const { client, written, dispatch } = createMockClient()
      client.allowWrite = false
      dispatch([{
        jsonrpc: '2.0',
        id: 42,
        method: 'session/request_permission',
        params: {
          sessionId: 's1',
          options: [
            { optionId: 'approve_always', name: 'Always', kind: 'allow_always' },
          ],
          toolCall: { toolCallId: 't1', title: 'Write' },
        },
      }])
      await flush()

      const reply = JSON.parse(written[0].toString('utf-8'))
      expect(reply.id).toBe(42)
      expect(reply.result).toEqual({ outcome: { outcome: 'cancelled' } })
    })

    it('writes fs write_text_file when allowWrite is true', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-rw-write-test-'))
      const { client, written, dispatch } = createMockClient()
      client.workDir = tmpDir

      dispatch([{ jsonrpc: '2.0', id: 1, method: 'fs/write_text_file', params: { sessionId: 's1', path: 'nested/file.txt', content: 'hello acp' } }])
      await flush()

      const reply = JSON.parse(written[0].toString('utf-8'))
      expect(reply.id).toBe(1)
      expect(reply.result).toEqual({})
      expect(await fs.readFile(path.join(tmpDir, 'nested/file.txt'), 'utf-8')).toBe('hello acp')
      await fs.rm(tmpDir, { recursive: true, force: true })
    })
  })
})

describe('acp progress reporting', () => {
  function createMockAcpServer() {
    const callbacks: Record<string, ((...args: unknown[]) => void)[]> = {}
    const written: Buffer[] = []
    const on = (event: string, cb: (...args: unknown[]) => void) => {
      callbacks[event] = callbacks[event] ?? []
      callbacks[event].push(cb)
    }
    const proc = {
      pid: 42,
      killed: false,
      kill: vi.fn(),
      stdin: {
        write: (chunk: Buffer, callback?: (error?: Error | null) => void) => {
          written.push(Buffer.from(chunk))
          const message = JSON.parse(chunk.toString('utf-8').trim()) as { id?: number; method?: string }
          const requestId = message.id

          if (message.method === 'initialize') {
            proc.emit('data', encodeAcpMessage({ jsonrpc: '2.0', id: requestId, result: { protocolVersion: 1, serverInfo: { name: 'kimi', version: '1.0' }, capabilities: {} } }))
          } else if (message.method === 'session/new') {
            proc.emit('data', encodeAcpMessage({ jsonrpc: '2.0', id: requestId, result: { sessionId: 's1' } }))
          } else if (message.method === 'session/prompt') {
            proc.emit('data', encodeAcpMessage({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' } } } }))
            proc.emit('data', encodeAcpMessage({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hidden thought' } } } }))
            proc.emit('data', encodeAcpMessage({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'b' } } } }))
            proc.emit('data', encodeAcpMessage({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Write' } } }))
            proc.emit('data', encodeAcpMessage({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'c' } } } }))
            proc.emit('data', encodeAcpMessage({ jsonrpc: '2.0', id: requestId, result: { text: 'done' } }))
          }

          callback?.(null)
          return true
        },
      },
      stderr: { on },
      stdout: { on },
      on,
      emit: (event: string, ...args: unknown[]) => {
        for (const cb of callbacks[event] ?? []) cb(...args)
      },
    } as unknown as ReturnType<typeof import('node:child_process').spawn> & { stdin: { write: (chunk: Buffer, callback?: (error?: Error | null) => void) => boolean }; emit: (event: string, ...args: unknown[]) => void }
    return { proc, written }
  }

  it('coalesces message chunks and forwards tool_call immediately', async () => {
    const { proc } = createMockAcpServer()
    vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>)

    const events: ProgressEvent[] = []
    const result = await runAcpPrompt({ prompt: 'hello', onProgress: (e) => events.push(e) })

    expect(result.ok).toBe(true)
    const messageEvents = events.filter((e) => e.kind === 'message')
    expect(messageEvents.length).toBeLessThan(3)
    expect(messageEvents.some((e) => e.text.includes('c'))).toBe(true)
    expect(events.some((e) => e.kind === 'tool_call')).toBe(true)
  })

  it('does not include thinking in the result unless requested', async () => {
    const { proc } = createMockAcpServer()
    vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>)

    const result = await runAcpPrompt({ prompt: 'hello' })

    expect(result.ok).toBe(true)
    expect(result.text).not.toContain('hidden thought')
    expect(result.thinking).toBeUndefined()
  })

  it('returns thinking only when includeThinking is true', async () => {
    const { proc } = createMockAcpServer()
    vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>)

    const result = await runAcpPrompt({ prompt: 'hello', includeThinking: true })

    expect(result.ok).toBe(true)
    expect(result.text).not.toContain('hidden thought')
    expect(result.thinking).toContain('hidden thought')
  })

  it('emits a todo event when a tool_call_update carries a TodoList payload', async () => {
    const callbacks: Record<string, ((...args: unknown[]) => void)[]> = {}
    const on = (event: string, cb: (...args: unknown[]) => void) => {
      callbacks[event] = callbacks[event] ?? []
      callbacks[event].push(cb)
    }
    const proc = {
      pid: 42,
      killed: false,
      kill: vi.fn(),
      stdin: {
        write: (chunk: Buffer, callback?: (error?: Error | null) => void) => {
          const message = JSON.parse(chunk.toString('utf-8').trim()) as { id?: number; method?: string }
          if (message.method === 'initialize') {
            proc.emit('data', encodeAcpMessage({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, serverInfo: { name: 'kimi', version: '1.0' }, capabilities: {} } }))
          } else if (message.method === 'session/new') {
            proc.emit('data', encodeAcpMessage({ jsonrpc: '2.0', id: message.id, result: { sessionId: 's1' } }))
          } else if (message.method === 'session/prompt') {
            proc.emit('data', encodeAcpMessage({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', content: [{ type: 'content', content: { type: 'text', text: JSON.stringify({ todos: [{ title: 'Plan', status: 'done' }, { title: 'Build', status: 'in_progress' }] }) } }] } } }))
            proc.emit('data', encodeAcpMessage({ jsonrpc: '2.0', id: message.id, result: { text: 'done' } }))
          }
          callback?.(null)
          return true
        },
      },
      stderr: { on },
      stdout: { on },
      on,
      emit: (event: string, ...args: unknown[]) => {
        for (const cb of callbacks[event] ?? []) cb(...args)
      },
    } as unknown as ReturnType<typeof import('node:child_process').spawn> & { stdin: { write: (chunk: Buffer, callback?: (error?: Error | null) => void) => boolean }; emit: (event: string, ...args: unknown[]) => void }

    vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>)

    const events: ProgressEvent[] = []
    const result = await runAcpPrompt({ prompt: 'hello', onProgress: (e) => events.push(e) })

    expect(result.ok).toBe(true)
    const todoEvents = events.filter((e) => e.kind === 'todo')
    expect(todoEvents).toHaveLength(1)
    expect(todoEvents[0].text).toBe('TODO 1/2 ✓· · now: Build')
    expect(todoEvents[0].metadata?.todoFullList).toContain('[done] Plan')
    expect(todoEvents[0].metadata?.todoFullList).toContain('[in_progress] Build')
  })

  it('stops the stall watchdog when the prompt completes', async () => {
    vi.useFakeTimers()
    const { proc } = createMockAcpServer()
    vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>)

    const events: ProgressEvent[] = []
    await runAcpPrompt({ prompt: 'hello', onProgress: (e) => events.push(e) })

    vi.advanceTimersByTime(35_000)
    expect(events.some((e) => e.kind === 'stall')).toBe(false)
    vi.useRealTimers()
  })
})

describe('acp cancellation', () => {
  it('returns an aborted error when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await runAcpPrompt({ prompt: 'hello', signal: controller.signal })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/aborted/i)
  })

  it('kills the process and returns a cancellation error when aborted mid-run', async () => {
    const callbacks: Record<string, ((...args: unknown[]) => void)[]> = {}
    const on = (event: string, cb: (...args: unknown[]) => void) => {
      callbacks[event] = callbacks[event] ?? []
      callbacks[event].push(cb)
    }
    const proc = {
      pid: 42,
      killed: false,
      kill: vi.fn(),
      stdin: {
        write: (chunk: Buffer, callback?: (error?: Error | null) => void) => {
          const message = JSON.parse(chunk.toString('utf-8').trim()) as { id?: number; method?: string }
          if (message.method === 'initialize') {
            proc.emit('data', encodeAcpMessage({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, serverInfo: { name: 'kimi', version: '1.0' }, capabilities: {} } }))
          } else if (message.method === 'session/new') {
            proc.emit('data', encodeAcpMessage({ jsonrpc: '2.0', id: message.id, result: { sessionId: 's1' } }))
          }
          // session/prompt intentionally hangs to simulate a long-running call.
          callback?.(null)
          return true
        },
      },
      stderr: { on },
      stdout: { on },
      on,
      emit: (event: string, ...args: unknown[]) => {
        for (const cb of callbacks[event] ?? []) cb(...args)
      },
    } as unknown as ReturnType<typeof import('node:child_process').spawn> & { stdin: { write: (chunk: Buffer, callback?: (error?: Error | null) => void) => boolean }; emit: (event: string, ...args: unknown[]) => void }

    vi.mocked(spawn).mockImplementation((cmd, args) => {
      if (cmd === 'kimi.exe' || (Array.isArray(args) && args[0] === 'acp')) {
        return proc as unknown as ReturnType<typeof spawn>
      }
      return { pid: 999, killed: false, kill: vi.fn(), stdin: { write: () => true }, stderr: { on: () => undefined }, stdout: { on: () => undefined }, on: () => undefined } as unknown as ReturnType<typeof spawn>
    })

    const controller = new AbortController()
    const resultPromise = runAcpPrompt({ prompt: 'hello', signal: controller.signal })

    await new Promise((resolve) => setTimeout(resolve, 50))
    controller.abort()
    proc.emit('close', 1)

    const result = await resultPromise
    expect(result.ok).toBe(false)
    expect(result.error?.toLowerCase()).toContain('cancel')

    const taskkillCall = vi.mocked(spawn).mock.calls.find((call) => call[0] === 'taskkill')
    expect(taskkillCall).toEqual(['taskkill', ['/PID', '42', '/T', '/F'], expect.objectContaining({ stdio: 'ignore', windowsHide: true })])
  })
})

describe('acp process lifecycle', () => {
  function createMockProc(pid: number) {
    const callbacks: Record<string, ((...args: unknown[]) => void)[]> = {}
    return {
      pid,
      killed: false,
      kill: vi.fn(),
      stdin: { write: () => true },
      stderr: { on: () => undefined },
      stdout: { on: () => undefined },
      on: (event: string, cb: (...args: unknown[]) => void) => {
        callbacks[event] = callbacks[event] ?? []
        callbacks[event].push(cb)
      },
      emit: (event: string, ...args: unknown[]) => {
        for (const cb of callbacks[event] ?? []) cb(...args)
      },
    }
  }

  it('close kills the whole process tree and resolves closed when the child exits', async () => {
    const mockProc = createMockProc(42)
    vi.mocked(spawn).mockImplementation((cmd, args) => {
      if (cmd === 'kimi.exe' || (Array.isArray(args) && args[0] === 'acp')) {
        return mockProc as unknown as ReturnType<typeof spawn>
      }
      return createMockProc(999) as unknown as ReturnType<typeof spawn>
    })

    const client = new AcpClient()
    client.start()
    const closedPromise = client.closed

    client.close()
    client.close() // guard against double-kill

    const taskkillCall = vi.mocked(spawn).mock.calls.find((call) => call[0] === 'taskkill')
    expect(taskkillCall).toEqual(['taskkill', ['/PID', '42', '/T', '/F'], expect.objectContaining({ stdio: 'ignore', windowsHide: true })])
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2)

    mockProc.emit('close', 1)
    await expect(closedPromise).resolves.toBeUndefined()
  })
})
