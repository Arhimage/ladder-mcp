import { beforeEach, describe, expect, it, vi } from 'vitest'

const registeredTools: Record<
  string,
  { description: string; schema: Record<string, unknown>; handler: (args: Record<string, unknown>, extra?: unknown) => Promise<unknown> }
> = {}

function createMockServer() {
  return {
    tool: vi.fn((name: string, description: string, schema: Record<string, unknown>, ...rest: unknown[]) => {
      const handler = rest[rest.length - 1] as (args: Record<string, unknown>, extra?: unknown) => Promise<unknown>
      registeredTools[name] = { description, schema, handler }
    }),
  }
}

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: vi.fn().mockImplementation(createMockServer),
}))

vi.mock('./input-validation.js', () => ({
  maxChars: vi.fn((tokens: number | undefined) => (typeof tokens === 'number' && tokens > 0 ? tokens * 4 : 60_000)),
  validateWorkDir: vi.fn((workDir: string) => (workDir.startsWith('BAD') ? `work_dir invalid: ${workDir}` : undefined)),
}))

vi.mock('./environment.js', () => ({
  getKimiStatus: vi.fn().mockResolvedValue({
    installed: true,
    binPath: 'C:\\kimi\\kimi.exe',
    version: '1.2.3',
    authenticated: true,
    catalogFound: true,
    catalogPath: 'C:\\Users\\test\\.kimi-code',
    configFound: true,
    credentialsFound: true,
    apiConfigured: false,
  }),
  isApiConfigured: vi.fn().mockReturnValue(false),
}))

vi.mock('./kimi-api.js', () => ({
  runKimiApi: vi.fn().mockResolvedValue({ ok: true, text: 'api response' }),
  isApiConfigured: vi.fn().mockReturnValue(false),
}))



vi.mock('./session-store.js', () => ({
  listSessions: vi.fn().mockReturnValue([]),
}))

vi.mock('./transports/acp.js', () => ({
  runAcpPrompt: vi.fn().mockResolvedValue({ ok: true, text: 'acp response' }),
  listAcpSessions: vi.fn().mockResolvedValue({ ok: true, text: '{"sessions":[]}' }),
  cancelAcpSession: vi.fn().mockResolvedValue({ ok: true, text: '{}' }),
  ACP_TIMEOUT_FLOOR_MS: 1_800_000,
}))

vi.mock('./transports/cli-admin.js', () => ({
  exportKimiSession: vi.fn().mockResolvedValue({ ok: true, stdout: '', stderr: '' }),
  getKimiCapabilities: vi.fn().mockResolvedValue({ cli: { installed: true }, commands: {}, acp: { available: true, command: 'kimi acp' }, desktop: { experimental: true, readOnly: true } }),
  runKimiDoctor: vi.fn().mockResolvedValue({ ok: true, stdout: '', stderr: '' }),
  listKimiProviders: vi.fn().mockResolvedValue([{ name: 'default' }]),
  visualizeSession: vi.fn().mockReturnValue({ command: 'kimi vis', url: 'http://127.0.0.1:58628/', launched: false }),
}))

const fakeTask = {
  id: 'task_1_abcdef',
  kind: 'test',
  status: 'pending',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  outputLength: 0,
}

const fakeOutputSlice = {
  id: 'task_1_abcdef',
  status: 'pending',
  mode: 'full',
  lines: [],
  offset: 0,
  totalLines: 0,
  hasMore: false,
}

const fakeTaskStore = {
  create: vi.fn().mockReturnValue(fakeTask),
  get: vi.fn().mockReturnValue(fakeTask),
  status: vi.fn().mockReturnValue(fakeTask),
  list: vi.fn().mockReturnValue([fakeTask]),
  cancel: vi.fn().mockReturnValue(fakeTask),
  output: vi.fn().mockReturnValue(fakeOutputSlice),
}

vi.mock('./task-store.js', () => ({
  taskStore: fakeTaskStore,
}))

vi.mock('./kimi-mcp-config.js', () => ({
  generateMcpConfig: vi.fn().mockReturnValue({ path: 'C:\\project\\.kimi-code\\mcp.json', serverName: 'ladder_mcp', config: {}, wrote: false }),
}))

vi.mock('./desktop-work.js', () => ({
  getDesktopStatus: vi.fn().mockResolvedValue({ experimental: true, readOnly: true, safety: [] }),
  buildBudgetProbeGuide: vi.fn().mockReturnValue('budget probe guide'),
}))

vi.mock('./version.js', () => ({
  VERSION: '1.1.0-test',
}))

async function loadServer(env?: { LADDER_EXPERIMENTAL?: string }) {
  if (env?.LADDER_EXPERIMENTAL !== undefined) {
    vi.stubEnv('LADDER_EXPERIMENTAL', env.LADDER_EXPERIMENTAL)
  }
  await import('./index.js')
}

beforeEach(() => {
  vi.resetModules()
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  for (const key of Object.keys(registeredTools)) {
    delete registeredTools[key]
  }
})

describe('tool surface registration', () => {
  it('registers exactly the 6 default intent-first tools', async () => {
    await loadServer()
    expect(Object.keys(registeredTools)).toEqual([
      'kimi_code',
      'kimi_ask',
      'kimi_sessions',
      'kimi_tasks',
      'kimi_status',
      'kimi_setup',
    ])
  })

  it('does not register experimental tools by default', async () => {
    await loadServer()
    expect(registeredTools.kimi_export_session).toBeUndefined()
    expect(registeredTools.kimi_visualize_session).toBeUndefined()
    expect(registeredTools.kimi_desktop_status).toBeUndefined()
    expect(registeredTools.kimi_budget_probe).toBeUndefined()
  })

  it('registers the 4 experimental tools when LADDER_EXPERIMENTAL=1', async () => {
    await loadServer({ LADDER_EXPERIMENTAL: '1' })
    expect(Object.keys(registeredTools)).toEqual([
      'kimi_code',
      'kimi_ask',
      'kimi_sessions',
      'kimi_tasks',
      'kimi_status',
      'kimi_setup',
      'kimi_export_session',
      'kimi_visualize_session',
      'kimi_desktop_status',
      'kimi_budget_probe',
    ])
  })
})

describe('kimi_code', () => {
  it('defaults to acp transport and validates work_dir', async () => {
    await loadServer()
    const { runAcpPrompt } = await import('./transports/acp.js')
    const result = await registeredTools.kimi_code.handler({ prompt: 'hello', work_dir: 'C:\\good' })
    expect(runAcpPrompt).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.stringContaining('hello'), sessionMode: 'new' }))
    expect(result).toEqual({ content: [{ type: 'text', text: expect.stringContaining('acp response') }], isError: false })
    expect(result).toEqual({ content: [{ type: 'text', text: expect.not.stringContaining('If this call reports a timeout') }], isError: false })
  })

  it('rejects invalid work_dir', async () => {
    await loadServer()
    const result = await registeredTools.kimi_code.handler({ prompt: 'hello', work_dir: 'BAD' })
    expect(result).toEqual({ content: [{ type: 'text', text: 'Error: work_dir invalid: BAD' }], isError: true })
  })

  it('rejects non-positive or non-integer timeout_ms at the schema boundary', async () => {
    await loadServer()
    const codeTimeout = registeredTools.kimi_code.schema.timeout_ms as { safeParse: (value: unknown) => { success: boolean } }
    const askTimeout = registeredTools.kimi_ask.schema.timeout_ms as { safeParse: (value: unknown) => { success: boolean } }
    for (const schema of [codeTimeout, askTimeout]) {
      expect(schema.safeParse(0).success).toBe(false)
      expect(schema.safeParse(-1).success).toBe(false)
      expect(schema.safeParse(1.5).success).toBe(false)
      expect(schema.safeParse(Number.NaN).success).toBe(false)
      expect(schema.safeParse(30_000).success).toBe(true)
    }
  })

  it('passes timeout_ms through to ACP transport', async () => {
    await loadServer()
    const { runAcpPrompt } = await import('./transports/acp.js')
    await registeredTools.kimi_code.handler({ prompt: 'hello', work_dir: 'C:\\good', timeout_ms: 30_000 })
    expect(runAcpPrompt).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 30_000 }))
  })

  it('prefixes ACP prompts with read-only guard by default', async () => {
    await loadServer()
    const { runAcpPrompt } = await import('./transports/acp.js')
    await registeredTools.kimi_code.handler({ prompt: 'hello', work_dir: 'C:\\good' })
    expect(runAcpPrompt).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.stringContaining('READ-ONLY MODE') }))
  })

  it('prefixes ACP prompts with edit guard when edit=true', async () => {
    await loadServer()
    const { runAcpPrompt } = await import('./transports/acp.js')
    await registeredTools.kimi_code.handler({ prompt: 'hello', work_dir: 'C:\\good', edit: true })
    expect(runAcpPrompt).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.stringContaining('EDIT MODE') }))
  })

  it('allows timeout_ms above the ACP floor', async () => {
    await loadServer()
    const { runAcpPrompt } = await import('./transports/acp.js')
    await registeredTools.kimi_code.handler({ prompt: 'hello', work_dir: 'C:\\good', timeout_ms: 3_600_000 })
    expect(runAcpPrompt).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 3_600_000 }))
  })

  it('has no cli transport parameter', async () => {
    await loadServer()
    expect(registeredTools.kimi_code.schema.transport).toBeUndefined()
  })

  it('honors acp session_mode=load', async () => {
    await loadServer()
    const { runAcpPrompt } = await import('./transports/acp.js')
    await registeredTools.kimi_code.handler({ prompt: 'hello', work_dir: 'C:\\good', session_id: 'sess_1', session_mode: 'load' })
    expect(runAcpPrompt).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess_1', sessionMode: 'load' }))
  })

  it('passes onProgress to foreground acp handler', async () => {
    await loadServer()
    const { runAcpPrompt } = await import('./transports/acp.js')
    const sendNotification = vi.fn()
    await registeredTools.kimi_code.handler(
      { prompt: 'hello', work_dir: 'C:\\good' },
      { sendNotification, _meta: { progressToken: 'token' } },
    )
    expect(runAcpPrompt).toHaveBeenCalledWith(expect.objectContaining({ onProgress: expect.any(Function) }))
  })

  it('passes MCP cancellation signal to foreground acp handler', async () => {
    await loadServer()
    const { runAcpPrompt } = await import('./transports/acp.js')
    const signal = new AbortController().signal
    await registeredTools.kimi_code.handler({ prompt: 'hello', work_dir: 'C:\\good' }, { signal })
    expect(runAcpPrompt).toHaveBeenCalledWith(expect.objectContaining({ signal }))
  })

  it('tracks background acp work as a task', async () => {
    await loadServer()
    await registeredTools.kimi_code.handler({ prompt: 'hello', work_dir: 'C:\\good', background: true })
    expect(fakeTaskStore.create).toHaveBeenCalledWith('acp-code', expect.any(Function))
  })

  it('includes continuation instruction and session_id in timeout response', async () => {
    await loadServer()
    const { runAcpPrompt } = await import('./transports/acp.js')
    vi.mocked(runAcpPrompt).mockResolvedValueOnce({ ok: false, text: '', error: 'ACP request timed out', sessionId: 'sess_timeout', resumable: true })
    const result = await registeredTools.kimi_code.handler({ prompt: 'hello', work_dir: 'C:\\good' })
    expect(result).toEqual(expect.objectContaining({ isError: true }))
    expect(result).toEqual({ content: [{ type: 'text', text: expect.stringContaining('new_session=false') }], isError: true })
    expect(result).toEqual({ content: [{ type: 'text', text: expect.stringContaining('sess_timeout') }], isError: true })
  })
})

describe('kimi_ask', () => {
  it('runs query mode without context', async () => {
    await loadServer()
    const { runKimiApi } = await import('./kimi-api.js')
    await registeredTools.kimi_ask.handler({ prompt: 'what is node?' })
    expect(runKimiApi).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'what is node?' }))
  })

  it('runs verify mode with context', async () => {
    await loadServer()
    const { runKimiApi } = await import('./kimi-api.js')
    await registeredTools.kimi_ask.handler({ prompt: 'check this', context: 'const x = 1', role: 'senior' })
    expect(runKimiApi).toHaveBeenCalledWith(expect.objectContaining({
      system: 'senior',
      prompt: expect.stringContaining('const x = 1'),
    }))
  })
})

describe('kimi_sessions', () => {
  it('lists cli sessions', async () => {
    await loadServer()
    const { listSessions } = await import('./session-store.js')
    await registeredTools.kimi_sessions.handler({ source: 'cli', work_dir: 'C:\\good' })
    expect(listSessions).toHaveBeenCalledWith({ workDir: 'C:\\good', limit: 20 })
  })

  it('lists acp sessions', async () => {
    await loadServer()
    const { listAcpSessions } = await import('./transports/acp.js')
    await registeredTools.kimi_sessions.handler({ source: 'acp' })
    expect(listAcpSessions).toHaveBeenCalledWith({ limit: 20, workDir: undefined })
  })

  it('combines sources when source=all', async () => {
    await loadServer()
    const { listSessions } = await import('./session-store.js')
    const { listAcpSessions } = await import('./transports/acp.js')
    const result = await registeredTools.kimi_sessions.handler({ source: 'all' })
    expect(listSessions).toHaveBeenCalled()
    expect(listAcpSessions).toHaveBeenCalled()
    expect(result).toEqual({
      content: [{ type: 'text', text: expect.stringContaining('"cli"') }],
      isError: false,
    })
  })

  it('handles invalid acp json when source=all', async () => {
    await loadServer()
    const { listAcpSessions } = await import('./transports/acp.js')
    vi.mocked(listAcpSessions).mockResolvedValueOnce({ ok: true, text: 'not json' })
    const result = await registeredTools.kimi_sessions.handler({ source: 'all' })
    expect(result).toEqual({
      content: [{ type: 'text', text: expect.stringContaining('ACP sessions response is not valid JSON') }],
      isError: false,
    })
  })
})

describe('kimi_tasks dispatch', () => {
  it('action=status lists all tasks when task_id omitted', async () => {
    await loadServer()
    await registeredTools.kimi_tasks.handler({ action: 'status' })
    expect(fakeTaskStore.list).toHaveBeenCalled()
  })

  it('action=status gets compact metadata when task_id provided', async () => {
    await loadServer()
    await registeredTools.kimi_tasks.handler({ action: 'status', task_id: 'task_1' })
    expect(fakeTaskStore.status).toHaveBeenCalledWith('task_1')
  })

  it('action=status snapshot does not include output body', async () => {
    await loadServer()
    const result = await registeredTools.kimi_tasks.handler({ action: 'status', task_id: 'task_1' })
    expect(result).toEqual({ content: [{ type: 'text', text: expect.not.stringContaining('"output"') }], isError: false })
  })

  it('action=output requires task_id', async () => {
    await loadServer()
    const result = await registeredTools.kimi_tasks.handler({ action: 'output' })
    expect(result).toEqual({ content: [{ type: 'text', text: 'task_id is required for action=output.' }], isError: true })
  })

  it('action=output paginates full mode', async () => {
    await loadServer()
    await registeredTools.kimi_tasks.handler({ action: 'output', task_id: 'task_1', mode: 'full', offset: 10, limit: 50 })
    expect(fakeTaskStore.output).toHaveBeenCalledWith('task_1', 'full', 10, 50)
  })

  it('action=output supports final mode', async () => {
    await loadServer()
    await registeredTools.kimi_tasks.handler({ action: 'output', task_id: 'task_1', mode: 'final' })
    expect(fakeTaskStore.output).toHaveBeenCalledWith('task_1', 'final', 0, 100)
  })

  it('action=output keeps oversized JSON responses parseable', async () => {
    fakeTaskStore.output.mockReturnValueOnce({
      ...fakeOutputSlice,
      lines: ['x'.repeat(20_000)],
      totalLines: 1,
    })
    await loadServer()
    const result = await registeredTools.kimi_tasks.handler({ action: 'output', task_id: 'task_1' }) as { content: [{ text: string }]; isError: boolean }
    expect(result.isError).toBe(false)
    const parsed = JSON.parse(result.content[0].text) as { truncated?: boolean; message?: string }
    expect(parsed.truncated).toBe(true)
    expect(parsed.message).toContain('smaller valid JSON response')
  })

  it('action=cancel rejects both task_id and session_id', async () => {
    await loadServer()
    const result = await registeredTools.kimi_tasks.handler({ action: 'cancel', task_id: 'task_1', session_id: 'sess_1' })
    expect(result).toEqual({ content: [{ type: 'text', text: 'Provide either task_id or session_id, not both.' }], isError: true })
  })

  it('action=cancel cancels an acp session by session_id', async () => {
    await loadServer()
    const { cancelAcpSession } = await import('./transports/acp.js')
    await registeredTools.kimi_tasks.handler({ action: 'cancel', session_id: 'sess_1' })
    expect(cancelAcpSession).toHaveBeenCalledWith('sess_1')
  })
})

describe('kimi_status detail switch', () => {
  it('detail=basic returns status only', async () => {
    await loadServer()
    const { getKimiCapabilities } = await import('./transports/cli-admin.js')
    const result = await registeredTools.kimi_status.handler({ detail: 'basic' })
    expect(getKimiCapabilities).not.toHaveBeenCalled()
    expect(result).toEqual(expect.objectContaining({ isError: false }))
  })

  it('reports the ladder-mcp server version', async () => {
    await loadServer()
    const { VERSION } = await import('./version.js')
    const result = await registeredTools.kimi_status.handler({ detail: 'basic' })
    expect(result).toEqual({
      content: [{ type: 'text', text: expect.stringContaining(`Version: ${VERSION}`) }],
      isError: false,
    })
  })

  it('separates session auth from api auth', async () => {
    await loadServer()
    const result = await registeredTools.kimi_status.handler({ detail: 'basic' })
    expect(result).toEqual({
      content: [{ type: 'text', text: expect.stringContaining('Session authenticated (for kimi_code)') }],
      isError: false,
    })
    expect(result).toEqual({
      content: [{ type: 'text', text: expect.stringContaining('Kimi Code API auth (for kimi_ask)') }],
      isError: false,
    })
  })

  it('detail=full adds capabilities, doctor, and providers', async () => {
    await loadServer()
    const { getKimiCapabilities, runKimiDoctor, listKimiProviders } = await import('./transports/cli-admin.js')
    await registeredTools.kimi_status.handler({ detail: 'full' })
    expect(getKimiCapabilities).toHaveBeenCalled()
    expect(runKimiDoctor).toHaveBeenCalledWith('config', undefined)
    expect(listKimiProviders).toHaveBeenCalled()
  })

  it('isError is true when remediation is required', async () => {
    await loadServer()
    const { getKimiStatus } = await import('./environment.js')
    vi.mocked(getKimiStatus).mockResolvedValueOnce({
      installed: false,
      binPath: undefined,
      version: undefined,
      authenticated: false,
      catalogFound: false,
      catalogPath: 'C:\\Users\\test\\.kimi-code',
      configFound: false,
      credentialsFound: false,
      apiConfigured: false,
      error: 'Install Kimi CLI',
    })
    const result = await registeredTools.kimi_status.handler({})
    expect(result).toEqual(expect.objectContaining({ isError: true }))
  })

  it('detail=full sets isError when a subcall fails', async () => {
    await loadServer()
    const { runKimiDoctor } = await import('./transports/cli-admin.js')
    vi.mocked(runKimiDoctor).mockResolvedValueOnce({ ok: false, stdout: '', stderr: '', error: 'doctor failed' })
    const result = await registeredTools.kimi_status.handler({ detail: 'full' })
    expect(result).toEqual(expect.objectContaining({ isError: true }))
  })

  it('passes doctor_target and doctor_path to runKimiDoctor when detail=full', async () => {
    await loadServer()
    const { runKimiDoctor } = await import('./transports/cli-admin.js')
    await registeredTools.kimi_status.handler({ detail: 'full', doctor_target: 'tui', doctor_path: 'C:\\custom\\tui.toml' })
    expect(runKimiDoctor).toHaveBeenCalledWith('tui', 'C:\\custom\\tui.toml')
  })
})

describe('kimi_setup', () => {
  it('delegates to generateMcpConfig with resolved defaults', async () => {
    await loadServer()
    const { generateMcpConfig } = await import('./kimi-mcp-config.js')
    await registeredTools.kimi_setup.handler({})
    expect(generateMcpConfig).toHaveBeenCalledWith(expect.objectContaining({
      write: false,
      command: process.execPath,
    }))
  })
})

describe('experimental tools', () => {
  it('kimi_export_session delegates to exportKimiSession', async () => {
    await loadServer({ LADDER_EXPERIMENTAL: '1' })
    const { exportKimiSession } = await import('./transports/cli-admin.js')
    await registeredTools.kimi_export_session.handler({ output_path: 'out.zip' })
    expect(exportKimiSession).toHaveBeenCalledWith(expect.objectContaining({ outputPath: 'out.zip' }))
  })

  it('kimi_visualize_session delegates to visualizeSession', async () => {
    await loadServer({ LADDER_EXPERIMENTAL: '1' })
    const { visualizeSession } = await import('./transports/cli-admin.js')
    await registeredTools.kimi_visualize_session.handler({ launch: true })
    expect(visualizeSession).toHaveBeenCalledWith(expect.objectContaining({ launch: true }))
  })

  it('kimi_desktop_status delegates to getDesktopStatus', async () => {
    await loadServer({ LADDER_EXPERIMENTAL: '1' })
    const { getDesktopStatus } = await import('./desktop-work.js')
    await registeredTools.kimi_desktop_status.handler({})
    expect(getDesktopStatus).toHaveBeenCalled()
  })

  it('kimi_budget_probe delegates to buildBudgetProbeGuide', async () => {
    await loadServer({ LADDER_EXPERIMENTAL: '1' })
    const { buildBudgetProbeGuide } = await import('./desktop-work.js')
    await registeredTools.kimi_budget_probe.handler({})
    expect(buildBudgetProbeGuide).toHaveBeenCalledWith(false)
  })
})
