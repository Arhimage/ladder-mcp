import { beforeEach, describe, expect, it, vi } from 'vitest'

const registeredTools: Record<
  string,
  { description: string; schema: Record<string, unknown>; handler: (args: Record<string, unknown>, extra?: unknown) => Promise<unknown> }
> = {}

function createMockServer() {
  return {
    tool: vi.fn((name: string, _description: string, schema: Record<string, unknown>, ...rest: unknown[]) => {
      const handler = rest[rest.length - 1] as (args: Record<string, unknown>, extra?: unknown) => Promise<unknown>
      registeredTools[name] = { description: _description, schema, handler }
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
    apiConfigured: true,
  }),
}))

vi.mock('./kimi-api.js', () => ({
  runKimiApi: vi.fn().mockResolvedValue({ ok: true, text: 'kimi api response' }),
  isApiConfigured: vi.fn().mockReturnValue(true),
}))

vi.mock('./providers/minimax.js', () => ({
  getMinimaxStatus: vi.fn().mockResolvedValue({
    installed: true,
    binPath: 'C:\\bin\\mmx.exe',
    version: 'mmx 1.0.16',
    authenticated: true,
    error: undefined,
  }),
  runMinimaxAsk: vi.fn().mockResolvedValue({ ok: true, text: 'minimax response' }),
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
  getKimiCapabilities: vi.fn().mockResolvedValue({}),
  runKimiDoctor: vi.fn().mockResolvedValue({ ok: true, stdout: '', stderr: '' }),
  listKimiProviders: vi.fn().mockResolvedValue([]),
  visualizeSession: vi.fn().mockReturnValue({}),
}))

const fakeTask = {
  id: 'task_1_abcdef',
  kind: 'test',
  status: 'pending',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  outputLength: 0,
}

const fakeTaskStore = {
  create: vi.fn().mockReturnValue(fakeTask),
  get: vi.fn().mockReturnValue(fakeTask),
  status: vi.fn().mockReturnValue(fakeTask),
  list: vi.fn().mockReturnValue([fakeTask]),
  cancel: vi.fn().mockReturnValue(fakeTask),
  output: vi.fn().mockReturnValue({ id: 'task_1_abcdef', status: 'pending', mode: 'full', lines: [], offset: 0, totalLines: 0, hasMore: false }),
  wait: vi.fn().mockResolvedValue(fakeTask),
  cancelAll: vi.fn().mockResolvedValue(undefined),
}

vi.mock('./task-store.js', () => ({
  taskStore: fakeTaskStore,
}))

vi.mock('./kimi-mcp-config.js', () => ({
  generateMcpConfig: vi.fn().mockReturnValue({ path: 'C:\\project\\.kimi-code\\mcp.json', serverName: 'ladder-mcp', config: {}, wrote: false }),
}))

vi.mock('./desktop-work.js', () => ({
  getDesktopStatus: vi.fn().mockResolvedValue({}),
  buildBudgetProbeGuide: vi.fn().mockReturnValue('budget probe guide'),
}))

vi.mock('./version.js', () => ({
  VERSION: '1.10.0-test',
}))

async function loadServer() {
  await import('./index.js')
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  for (const key of Object.keys(registeredTools)) {
    delete registeredTools[key]
  }
})

describe('agent_ask', () => {
  it('defaults to Kimi and forwards the prompt', async () => {
    await loadServer()
    const { runKimiApi } = await import('./kimi-api.js')
    await registeredTools.agent_ask.handler({ prompt: 'what is node?' })
    expect(runKimiApi).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'what is node?' }))
  })

  it('dispatches to MiniMax when provider=minimax', async () => {
    await loadServer()
    const { runMinimaxAsk } = await import('./providers/minimax.js')
    const result = await registeredTools.agent_ask.handler({ prompt: 'hello', provider: 'minimax' })
    expect(runMinimaxAsk).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'hello', provider: 'minimax' }))
    expect(result).toEqual({ content: [{ type: 'text', text: 'minimax response' }], isError: false })
  })

  it('returns an error for unsupported providers', async () => {
    await loadServer()
    const result = await registeredTools.agent_ask.handler({ prompt: 'hello', provider: 'openai' })
    expect(result).toEqual(expect.objectContaining({ isError: true }))
    expect((result as { content: [{ text: string }] }).content[0].text).toContain('Unknown provider')
  })
})

describe('agent_status', () => {
  it('reports both Kimi and MiniMax status', async () => {
    await loadServer()
    const { getKimiStatus } = await import('./environment.js')
    const { getMinimaxStatus } = await import('./providers/minimax.js')
    const result = await registeredTools.agent_status.handler({ detail: 'basic' })
    expect(getKimiStatus).toHaveBeenCalled()
    expect(getMinimaxStatus).toHaveBeenCalled()
    const text = (result as { content: [{ text: string }] }).content[0].text
    expect(text).toContain('## Kimi')
    expect(text).toContain('## MiniMax')
    expect(text).toContain('mmx 1.0.16')
  })
})

describe('agent_tasks', () => {
  it('wraps the same task-store semantics as kimi_tasks', async () => {
    await loadServer()
    await registeredTools.agent_tasks.handler({ action: 'status' })
    expect(fakeTaskStore.list).toHaveBeenCalled()
  })
})
