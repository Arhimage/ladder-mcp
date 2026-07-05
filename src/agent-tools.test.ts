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

vi.mock('./agent-code-kimi.js', () => ({
  runKimiCodeAgent: vi.fn().mockResolvedValue({ ok: true, text: 'kimi result', sessionId: 'kimi_sess' }),
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
  }),
}))

vi.mock('./kimi-api.js', () => ({
  isApiConfigured: vi.fn().mockReturnValue(false),
}))

vi.mock('./input-validation.js', () => ({
  maxChars: vi.fn((tokens: number | undefined) => (typeof tokens === 'number' && tokens > 0 ? tokens * 4 : 60_000)),
  validateWorkDir: vi.fn((workDir: string) => (workDir.startsWith('BAD') ? `work_dir invalid: ${workDir}` : undefined)),
}))

vi.mock('./progress.js', () => ({
  createMcpProgressReporter: vi.fn().mockReturnValue(() => {}),
  formatTaskLogLine: vi.fn((event: { text: string }) => event.text),
}))

vi.mock('./providers/minimax-code.js', () => ({
  runMinimaxCode: vi.fn().mockResolvedValue({ ok: true, text: 'minimax result', sessionId: 'minimax_sess' }),
}))

vi.mock('./providers/registry.js', () => ({
  runAgentAsk: vi.fn().mockResolvedValue({ ok: true, text: 'ask result' }),
}))

vi.mock('./providers/minimax.js', () => ({
  getMinimaxStatus: vi.fn().mockResolvedValue({ installed: false, authenticated: false }),
}))

vi.mock('./transports/acp.js', () => ({
  cancelAcpSession: vi.fn().mockResolvedValue({ ok: true, text: '{}' }),
}))

vi.mock('./version.js', () => ({
  VERSION: '1.1.0-test',
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
  output: vi.fn().mockReturnValue({ lines: [], offset: 0, totalLines: 0, hasMore: false }),
  wait: vi.fn().mockResolvedValue(fakeTask),
  cancelAll: vi.fn().mockResolvedValue(undefined),
}

vi.mock('./task-store.js', () => ({
  taskStore: fakeTaskStore,
}))

async function loadTools() {
  const { registerAgentTools } = await import('./agent-tools.js')
  registerAgentTools(createMockServer() as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const key of Object.keys(registeredTools)) {
    delete registeredTools[key]
  }
  vi.resetModules()
})

describe('registerAgentTools', () => {
  it('registers agent_code with the expected schema', async () => {
    await loadTools()
    expect(registeredTools.agent_code).toBeDefined()
    expect(registeredTools.agent_code.schema.prompt).toBeDefined()
    expect(registeredTools.agent_code.schema.work_dir).toBeDefined()
    const providerSchema = registeredTools.agent_code.schema.provider as { safeParse?: (value: unknown) => { success: boolean } }
    expect(providerSchema.safeParse?.('kimi').success).toBe(true)
    expect(providerSchema.safeParse?.('minimax').success).toBe(true)
    expect(registeredTools.agent_code.schema.session_id).toBeDefined()
    expect(registeredTools.agent_code.schema.edit).toBeDefined()
    expect(registeredTools.agent_code.schema.background).toBeDefined()
    expect(registeredTools.agent_code.schema.detail_level).toBeDefined()
    expect(registeredTools.agent_code.schema.max_output_tokens).toBeDefined()
    expect(registeredTools.agent_code.schema.include_thinking).toBeDefined()
    expect(registeredTools.agent_code.schema.timeout_ms).toBeDefined()
  })

  it('rejects invalid work_dir for agent_code', async () => {
    await loadTools()
    const result = await registeredTools.agent_code.handler({ prompt: 'hello', work_dir: 'BAD' })
    expect(result).toEqual({ content: [{ type: 'text', text: 'Error: work_dir invalid: BAD' }], isError: true })
  })
})

describe('agent_code', () => {
  it('delegates provider=kimi to runKimiCodeAgent in foreground', async () => {
    await loadTools()
    const { runKimiCodeAgent } = await import('./agent-code-kimi.js')
    const result = await registeredTools.agent_code.handler({ prompt: 'hello', work_dir: 'C:\\good', provider: 'kimi' })
    expect(runKimiCodeAgent).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'hello', workDir: 'C:\\good' }))
    expect(result).toEqual({ content: [{ type: 'text', text: expect.stringContaining('kimi result') }], isError: false })
  })

  it('delegates provider=minimax to runMinimaxCode in foreground', async () => {
    await loadTools()
    const { runMinimaxCode } = await import('./providers/minimax-code.js')
    const result = await registeredTools.agent_code.handler({ prompt: 'hello', work_dir: 'C:\\good', provider: 'minimax' })
    expect(runMinimaxCode).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'hello', workDir: 'C:\\good' }))
    expect(result).toEqual({ content: [{ type: 'text', text: expect.stringContaining('minimax result') }], isError: false })
  })

  it('defaults provider to kimi', async () => {
    await loadTools()
    const { runKimiCodeAgent } = await import('./agent-code-kimi.js')
    await registeredTools.agent_code.handler({ prompt: 'hello', work_dir: 'C:\\good' })
    expect(runKimiCodeAgent).toHaveBeenCalled()
    const { runMinimaxCode } = await import('./providers/minimax-code.js')
    expect(runMinimaxCode).not.toHaveBeenCalled()
  })

  it('tracks background minimax work with kind minimax-code', async () => {
    await loadTools()
    await registeredTools.agent_code.handler({ prompt: 'hello', work_dir: 'C:\\good', provider: 'minimax', background: true })
    expect(fakeTaskStore.create).toHaveBeenCalledWith('minimax-code', expect.any(Function))
  })

  it('tracks background kimi work with kind acp-code', async () => {
    await loadTools()
    await registeredTools.agent_code.handler({ prompt: 'hello', work_dir: 'C:\\good', provider: 'kimi', background: true })
    expect(fakeTaskStore.create).toHaveBeenCalledWith('acp-code', expect.any(Function))
  })

  it('foreground result includes terminal envelope', async () => {
    await loadTools()
    const result = await registeredTools.agent_code.handler({ prompt: 'hello', work_dir: 'C:\\good', provider: 'minimax' })
    expect(result).toEqual({ content: [{ type: 'text', text: expect.stringContaining('Status: success') }], isError: false })
    expect(result).toEqual({ content: [{ type: 'text', text: expect.stringContaining('Session: minimax_sess') }], isError: false })
  })

  it('provider=minimax timeout envelope contains agent_code continuation', async () => {
    await loadTools()
    const { runMinimaxCode } = await import('./providers/minimax-code.js')
    vi.mocked(runMinimaxCode).mockResolvedValueOnce({ ok: false, text: '', error: 'MiniMax code run timed out after 30s', sessionId: 'minimax_timeout', resumable: true })
    const result = await registeredTools.agent_code.handler({ prompt: 'hello', work_dir: 'C:\\good', provider: 'minimax' })
    expect(result).toEqual(expect.objectContaining({ isError: true }))
    expect(result).toEqual({ content: [{ type: 'text', text: expect.stringContaining('Resume with: agent_code') }], isError: true })
    expect(result).toEqual({ content: [{ type: 'text', text: expect.stringContaining('calling agent_code again') }], isError: true })
    expect(result).toEqual({ content: [{ type: 'text', text: expect.stringContaining('session_id=minimax_timeout') }], isError: true })
  })

  it('provider=kimi include_thinking=true wraps thinking in kimi-thinking tags', async () => {
    await loadTools()
    const { runKimiCodeAgent } = await import('./agent-code-kimi.js')
    vi.mocked(runKimiCodeAgent).mockResolvedValueOnce({ ok: true, text: 'kimi result', thinking: 'kimi thought', sessionId: 'kimi_sess' })
    const result = await registeredTools.agent_code.handler({ prompt: 'hello', work_dir: 'C:\\good', provider: 'kimi', include_thinking: true })
    expect(result).toEqual(expect.objectContaining({ isError: false }))
    expect(result).toEqual({ content: [{ type: 'text', text: expect.stringContaining('<kimi-thinking>') }], isError: false })
    expect(result).toEqual({ content: [{ type: 'text', text: expect.stringContaining('kimi thought') }], isError: false })
    expect(result).toEqual({ content: [{ type: 'text', text: expect.not.stringContaining('<minimax-thinking>') }], isError: false })
  })

  it('provider=minimax include_thinking=true wraps thinking in minimax-thinking tags', async () => {
    await loadTools()
    const { runMinimaxCode } = await import('./providers/minimax-code.js')
    vi.mocked(runMinimaxCode).mockResolvedValueOnce({ ok: true, text: 'minimax result', thinking: 'minimax thought', sessionId: 'minimax_sess' })
    const result = await registeredTools.agent_code.handler({ prompt: 'hello', work_dir: 'C:\\good', provider: 'minimax', include_thinking: true })
    expect(result).toEqual(expect.objectContaining({ isError: false }))
    expect(result).toEqual({ content: [{ type: 'text', text: expect.stringContaining('<minimax-thinking>') }], isError: false })
    expect(result).toEqual({ content: [{ type: 'text', text: expect.stringContaining('minimax thought') }], isError: false })
    expect(result).toEqual({ content: [{ type: 'text', text: expect.not.stringContaining('<kimi-thinking>') }], isError: false })
  })
})
