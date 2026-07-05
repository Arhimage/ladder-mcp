import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}))

import { execFile } from 'node:child_process'
import {
  findMmxOnPath,
  getMmxAuthStatus,
  getMmxVersion,
  getMinimaxStatus,
  runMinimaxAsk,
} from './minimax.js'

function mockExecFile(stdout: string, stderr = '') {
  vi.mocked(execFile).mockImplementationOnce((_file, _args, _options, callback) => {
    if (callback) {
      callback(null, stdout, stderr)
    }
    return undefined as never
  })
}

function mockExecFileError(error: Error) {
  vi.mocked(execFile).mockImplementationOnce((_file, _args, _options, callback) => {
    if (callback) {
      callback(error, '', '')
    }
    return undefined as never
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('findMmxOnPath', () => {
  it('returns undefined when PATH is empty', () => {
    expect(findMmxOnPath({ PATH: '' }, () => true)).toBeUndefined()
  })

  it('finds mmx.exe from a semicolon-separated Windows PATH', () => {
    const hit = 'C:\\Users\\test\\.mmx\\bin\\mmx.exe'
    const found = findMmxOnPath(
      { PATH: 'C:\\Windows;C:\\Users\\test\\.mmx\\bin' },
      (candidate) => candidate === hit,
    )
    expect(found).toBe(hit)
  })

  it('also accepts the Path spelling', () => {
    const hit = 'C:\\bin\\mmx.exe'
    const found = findMmxOnPath(
      { Path: 'C:\\bin' },
      (candidate) => candidate === hit,
    )
    expect(found).toBe(hit)
  })

  it('finds mmx.cmd when mmx.exe is absent', () => {
    const hit = 'C:\\Users\\test\\AppData\\Roaming\\npm\\mmx.cmd'
    const found = findMmxOnPath(
      { PATH: 'C:\\Windows;C:\\Users\\test\\AppData\\Roaming\\npm' },
      (candidate) => candidate === hit,
    )
    expect(found).toBe(hit)
  })
})

describe('getMmxVersion', () => {
  it('returns trimmed stdout on success', async () => {
    mockExecFile('mmx 1.0.16\n', '')
    const version = await getMmxVersion('C:\\bin\\mmx.exe')
    expect(version).toBe('mmx 1.0.16')
  })

  it('returns undefined when the command fails', async () => {
    mockExecFileError(new Error('spawn ENOENT'))
    const version = await getMmxVersion('C:\\bin\\mmx.exe')
    expect(version).toBeUndefined()
  })
})

describe('getMmxAuthStatus', () => {
  it('parses authenticated=true and masks any api_key', async () => {
    mockExecFile(JSON.stringify({ authenticated: true, api_key: 'super-secret-key', user: 'alice' }), '')
    const status = await getMmxAuthStatus('C:\\bin\\mmx.exe')
    expect(status.authenticated).toBe(true)
    expect(status.username).toBe('alice')
    expect(JSON.stringify(status)).not.toContain('super-secret-key')
  })

  it('parses authenticated=false', async () => {
    mockExecFile(JSON.stringify({ authenticated: false }), '')
    const status = await getMmxAuthStatus('C:\\bin\\mmx.exe')
    expect(status.authenticated).toBe(false)
  })

  it('treats api-key method as authenticated and never leaks the key', async () => {
    mockExecFile(JSON.stringify({ method: 'api-key', source: 'config.json', key: 'sk-c...FxtM' }), '')
    const status = await getMmxAuthStatus('C:\\bin\\mmx.exe')
    expect(status.authenticated).toBe(true)
    expect(JSON.stringify(status)).not.toContain('sk-c...FxtM')
    expect(status).not.toHaveProperty('key')
  })

  it('masks tokens even when the response shape is unknown', async () => {
    mockExecFile(JSON.stringify({ token: 'abc123', access_token: 'xyz', refresh_token: 'qrs' }), '')
    const status = await getMmxAuthStatus('C:\\bin\\mmx.exe')
    expect(status.authenticated).toBe(true)
    expect(JSON.stringify(status)).not.toContain('abc123')
    expect(JSON.stringify(status)).not.toContain('xyz')
    expect(JSON.stringify(status)).not.toContain('qrs')
  })

  it('returns an error when the command fails', async () => {
    mockExecFileError(new Error('exit code 1'))
    const status = await getMmxAuthStatus('C:\\bin\\mmx.exe')
    expect(status.authenticated).toBe(false)
    expect(status.error).toContain('exit code 1')
  })
})

describe('getMinimaxStatus', () => {
  it('reports not installed when mmx is absent', async () => {
    const status = await getMinimaxStatus({ PATH: '' }, () => false)
    expect(status.installed).toBe(false)
    expect(status.error).toContain('not found')
  })

  it('reports installed and authenticated when checks succeed', async () => {
    const bin = 'C:\\bin\\mmx.exe'
    mockExecFile('mmx 1.0.16\n', '')
    mockExecFile(JSON.stringify({ authenticated: true, user: 'alice' }), '')
    const status = await getMinimaxStatus(
      { PATH: 'C:\\bin' },
      (candidate) => candidate === bin,
    )
    expect(status.installed).toBe(true)
    expect(status.binPath).toBe(bin)
    expect(status.version).toBe('mmx 1.0.16')
    expect(status.authenticated).toBe(true)
  })
})

describe('runMinimaxAsk', () => {
  it('invokes mmx text chat with the expected JSON flags', async () => {
    const bin = 'C:\\bin\\mmx.exe'
    mockExecFile(JSON.stringify({ content: [{ type: 'text', text: 'hello back' }], stop_reason: 'end_turn' }), '')
    const result = await runMinimaxAsk({
      prompt: 'hello',
      env: { PATH: 'C:\\bin' },
      existsSync: (candidate) => candidate === bin,
    })
    expect(execFile).toHaveBeenCalledWith(
      bin,
      ['text', 'chat', '--message', 'hello', '--output', 'json', '--non-interactive', '--no-color', '--timeout', '120'],
      expect.objectContaining({ timeout: expect.any(Number), windowsHide: true }),
      expect.any(Function),
    )
    expect(result).toEqual({ ok: true, text: 'hello back', toolUses: undefined })
  })

  it('converts timeout_ms to seconds and rounds up', async () => {
    const bin = 'C:\\bin\\mmx.exe'
    mockExecFile(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), '')
    await runMinimaxAsk({
      prompt: 'hi',
      timeoutMs: 30_500,
      env: { PATH: 'C:\\bin' },
      existsSync: (candidate) => candidate === bin,
    })
    const call = vi.mocked(execFile).mock.calls[0]
    expect(call?.[1]).toContain('--timeout')
    const idx = (call?.[1] as string[]).indexOf('--timeout')
    expect((call?.[1] as string[])[idx + 1]).toBe('31')
  })

  it('concatenates text blocks and preserves thinking', async () => {
    const bin = 'C:\\bin\\mmx.exe'
    mockExecFile(JSON.stringify({
      content: [
        { type: 'thinking', thinking: 'I think' },
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ],
      stop_reason: 'end_turn',
    }), '')
    const result = await runMinimaxAsk({
      prompt: 'hi',
      env: { PATH: 'C:\\bin' },
      existsSync: (candidate) => candidate === bin,
    })
    expect(result.ok).toBe(true)
    expect(result.text).toBe('first\n\nsecond')
    expect(result.thinking).toBe('I think')
  })

  it('extracts tool_use blocks', async () => {
    const bin = 'C:\\bin\\mmx.exe'
    mockExecFile(JSON.stringify({
      content: [
        { type: 'text', text: 'I will search' },
        { type: 'tool_use', id: 'tu_1', name: 'search', input: { q: 'node' } },
      ],
      stop_reason: 'tool_use',
    }), '')
    const result = await runMinimaxAsk({
      prompt: 'search',
      env: { PATH: 'C:\\bin' },
      existsSync: (candidate) => candidate === bin,
    })
    expect(result.ok).toBe(true)
    expect(result.text).toBe('I will search')
    expect(result.toolUses).toEqual([{ id: 'tu_1', name: 'search', input: { q: 'node' } }])
  })

  it('truncates text to maxOutputChars and adds a notice', async () => {
    const bin = 'C:\\bin\\mmx.exe'
    const longText = 'a'.repeat(10_000)
    mockExecFile(JSON.stringify({ content: [{ type: 'text', text: longText }] }), '')
    const result = await runMinimaxAsk({
      prompt: 'hi',
      maxOutputChars: 100,
      env: { PATH: 'C:\\bin' },
      existsSync: (candidate) => candidate === bin,
    })
    expect(result.ok).toBe(true)
    expect(result.text?.length).toBeLessThan(longText.length)
    expect(result.text).toContain('truncated')
  })

  it('invokes mmx.cmd by resolving the npm shim to node + mmx.mjs', async () => {
    const bin = 'C:\\Users\\test\\AppData\\Roaming\\npm\\mmx.cmd'
    const script = 'C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\mmx-cli\\dist\\mmx.mjs'
    mockExecFile(JSON.stringify({ content: [{ type: 'text', text: 'hello back' }] }), '')
    await runMinimaxAsk({
      prompt: 'hello',
      env: { PATH: 'C:\\Users\\test\\AppData\\Roaming\\npm' },
      existsSync: (candidate) => candidate === bin || candidate === script,
    })
    const call = vi.mocked(execFile).mock.calls[0]
    expect(call?.[0]).toBe('node')
    expect(call?.[1]).toContain('text')
    expect(call?.[1]).toContain('chat')
    expect(call?.[1]).toContain('--message')
    expect(call?.[1]).toContain(script)
    expect(call?.[2]).not.toHaveProperty('shell')
  })

  it('keeps prompt metacharacters as a single argv value (no shell)', async () => {
    const bin = 'C:\\Users\\test\\AppData\\Roaming\\npm\\mmx.cmd'
    const script = 'C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\mmx-cli\\dist\\mmx.mjs'
    mockExecFile(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), '')
    await runMinimaxAsk({
      prompt: 'hello & whoami',
      env: { PATH: 'C:\\Users\\test\\AppData\\Roaming\\npm' },
      existsSync: (candidate) => candidate === bin || candidate === script,
    })
    const call = vi.mocked(execFile).mock.calls[0]
    const args = call?.[1] as string[]
    const messageArg = args[args.indexOf('--message') + 1]
    expect(messageArg).toBe('hello & whoami')
    expect(call?.[2]).not.toHaveProperty('shell')
  })

  it('fails when a .cmd shim does not resolve to the expected npm target', async () => {
    const bin = 'C:\\Users\\test\\AppData\\Roaming\\npm\\mmx.cmd'
    const result = await runMinimaxAsk({
      prompt: 'hi',
      env: { PATH: 'C:\\Users\\test\\AppData\\Roaming\\npm' },
      existsSync: (candidate) => candidate === bin,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('node_modules/mmx-cli/dist/mmx.mjs')
  })

  it('fails gracefully when mmx is not found', async () => {
    const result = await runMinimaxAsk({ prompt: 'hi', env: { PATH: '' }, existsSync: () => false })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('mmx')
    expect(result.error).toContain('PATH')
  })

  it('fails gracefully on non-zero exit', async () => {
    const bin = 'C:\\bin\\mmx.exe'
    mockExecFileError(new Error('Command failed: mmx text chat'))
    const result = await runMinimaxAsk({
      prompt: 'hi',
      env: { PATH: 'C:\\bin' },
      existsSync: (candidate) => candidate === bin,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('mmx text chat')
  })

  it('fails gracefully when stdout is not valid JSON', async () => {
    const bin = 'C:\\bin\\mmx.exe'
    mockExecFile('not json', '')
    const result = await runMinimaxAsk({
      prompt: 'hi',
      env: { PATH: 'C:\\bin' },
      existsSync: (candidate) => candidate === bin,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('JSON')
  })

  it('includes context and role in the prompt for MiniMax', async () => {
    const bin = 'C:\\bin\\mmx.exe'
    mockExecFile(JSON.stringify({ content: [{ type: 'text', text: 'reviewed' }] }), '')
    await runMinimaxAsk({
      prompt: 'check this',
      context: 'const x = 1',
      role: 'senior',
      env: { PATH: 'C:\\bin' },
      existsSync: (candidate) => candidate === bin,
    })
    const call = vi.mocked(execFile).mock.calls[0]
    const messageArg = (call?.[1] as string[])[(call?.[1] as string[]).indexOf('--message') + 1]
    expect(messageArg).toContain('check this')
    expect(messageArg).toContain('const x = 1')
    expect(messageArg).toContain('senior')
  })
})
