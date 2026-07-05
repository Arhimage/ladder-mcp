import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { runKimiCodeAgent } from './agent-code-kimi.js'
import { getKimiStatus } from './environment.js'
import { isApiConfigured } from './kimi-api.js'
import { maxChars, validateWorkDir } from './input-validation.js'
import {
  buildTerminalEnvelope,
  DEFAULT_TOOL_MAX_CHARS,
  formatTerminalEnvelope,
  guardResponse,
  wrapThinking,
} from './response.js'
import { runAgentCycle } from './agent-cycle.js'
import { runMinimaxCode } from './providers/minimax-code.js'
import { getMinimaxSessionsDir, listMinimaxSessions } from './providers/minimax-session.js'
import { runAgentAsk } from './providers/registry.js'
import { getMinimaxStatus } from './providers/minimax.js'
import type { ProviderId } from './providers/types.js'
import { listSessions } from './session-store.js'
import { taskStore } from './task-store.js'
import { cancelAcpSession, listAcpSessions } from './transports/acp.js'
import { VERSION } from './version.js'
import type { ProgressEvent } from './types.js'
import { createMcpProgressReporter, formatTaskLogLine } from './progress.js'

const DEFAULT_TASK_WAIT_TIMEOUT_MS = 20 * 60_000

function textResponse(text: string, isError = false, maxCharsLimit?: number) {
  const guarded = guardResponse(text, maxCharsLimit !== undefined ? { maxChars: maxCharsLimit } : undefined)
  return { content: [{ type: 'text' as const, text: guarded.text }], isError }
}

function jsonResponse(value: unknown, isError = false, maxChars = DEFAULT_TOOL_MAX_CHARS) {
  let serialized: string
  try {
    serialized = JSON.stringify(value, null, 2)
  } catch {
    serialized = JSON.stringify({ error: 'Response is not JSON-serializable.' }, null, 2)
  }
  if (serialized.length <= maxChars) {
    return { content: [{ type: 'text' as const, text: serialized }], isError }
  }
  const notice = `\n\n---\nJSON truncated by Ladder_mcp size guard (${serialized.length.toLocaleString()} of max ${maxChars.toLocaleString()} chars). Use pagination, filters, or a smaller limit to retrieve the rest as valid JSON.`
  const head = serialized.slice(0, Math.max(0, maxChars - notice.length))
  return { content: [{ type: 'text' as const, text: `${head}${notice}` }], isError }
}

function buildAgentResponse(text: string, thinking: string | undefined, includeThinking: boolean): string {
  return thinking && includeThinking ? `<thinking>\n${thinking}\n</thinking>\n\n${text}` : text
}

async function handleTasks(
  args: {
    action: 'wait' | 'status' | 'output' | 'cancel'
    task_id?: string
    session_id?: string
    mode?: 'final' | 'full'
    offset?: number
    limit?: number
    timeout_ms?: number
  },
  extra?: { signal?: AbortSignal },
) {
  const { action, task_id, session_id, mode, offset, limit, timeout_ms } = args
  if (action === 'wait') {
    if (!task_id) return textResponse('task_id is required for action=wait.', true)
    const snapshot = await taskStore.wait(task_id, timeout_ms ?? DEFAULT_TASK_WAIT_TIMEOUT_MS, extra?.signal)
    if (!snapshot) return textResponse(`Task not found: ${task_id}`, true)
    const tail = taskStore.output(task_id, 'final', 0, limit ?? 20)
    return jsonResponse({ ...snapshot, lastLines: tail?.lines ?? [] })
  }

  if (action === 'status') {
    if (task_id) {
      const task = taskStore.status(task_id)
      return task ? jsonResponse(task) : textResponse(`Task not found: ${task_id}`, true)
    }
    return jsonResponse(taskStore.list())
  }

  if (action === 'output') {
    if (!task_id) return textResponse('task_id is required for action=output.', true)
    const slice = taskStore.output(task_id, mode ?? 'full', offset ?? 0, limit ?? 100)
    return slice ? jsonResponse(slice) : textResponse(`Task not found: ${task_id}`, true)
  }

  if (task_id && session_id) {
    return textResponse('Provide either task_id or session_id, not both.', true)
  }
  if (task_id) {    const task = await taskStore.cancel(task_id)
    return task ? jsonResponse(task) : textResponse(`Task not found: ${task_id}`, true)
  }
  if (session_id) {
    const result = await cancelAcpSession(session_id)
    return jsonResponse(result, !result.ok)
  }
  return textResponse('Provide task_id or session_id.', true)
}

export function registerAgentTools(server: McpServer) {
  server.tool(
    'agent_ask',
    'Stateless question or independent review with a configurable provider.',
    {
      prompt: z.string().describe('The question to ask or the focus for verification.'),
      context: z.string().optional().describe('Material to examine (switches to verify mode).'),
      role: z.string().optional().describe('Reviewer persona override for verify mode.'),
      provider: z.enum(['kimi', 'minimax']).optional().describe("Provider: 'kimi' or 'minimax'. Default: 'kimi'."),
      max_output_tokens: z.number().optional(),
      include_thinking: z.boolean().optional(),
      timeout_ms: z.number().int().positive().optional(),
    },
    { title: 'Ask a provider a stateless question', readOnlyHint: true },
    async ({ prompt, context, role, provider, max_output_tokens, include_thinking, timeout_ms }) => {
      const includeThinkingValue = include_thinking ?? false
      const result = await runAgentAsk({
        prompt,
        context,
        role,
        provider: (provider ?? 'kimi') as ProviderId,
        timeoutMs: timeout_ms,
        maxOutputChars: maxChars(max_output_tokens),
      })
      if (!result.ok) return textResponse(`Error: ${result.error}`, true)
      return textResponse(
        buildAgentResponse(result.text, result.thinking, includeThinkingValue),
        false,
        maxChars(max_output_tokens),
      )
    },
  )

  server.tool(
    'agent_code',
    'Agentic work in a repository: analyze and edit files through a configurable provider. Pass session_id to continue a previous session; omit it to start a new one. For code-writing tasks with provider=minimax, prefer agent_cycle (built-in coder/reviewer loop) over a single agent_code call.',
    {
      prompt: z.string().describe('The analysis or coding prompt.'),
      work_dir: z.string().describe('Absolute path to the codebase root directory.'),
      provider: z.enum(['kimi', 'minimax']).optional().describe("Provider: 'kimi' or 'minimax'. Default: 'kimi'."),
      session_id: z.string().optional().describe('Session id to continue (from a previous agent_code response). Omit to start a new session.'),
      edit: z.boolean().optional().describe('Allow file modifications. Default: false (analysis-only).'),
      background: z.boolean().optional().describe('Run as a tracked background task; returns a task id immediately. Default false (foreground).'),
      detail_level: z.enum(['summary', 'normal', 'detailed']).optional(),
      max_output_tokens: z.number().optional(),
      include_thinking: z.boolean().optional(),
      timeout_ms: z.number().int().positive().optional(),
    },
    { title: 'Run agentic code work', destructiveHint: true },
    async ({ prompt, work_dir, provider, session_id, edit, background, detail_level, max_output_tokens, include_thinking, timeout_ms }, extra) => {
      const workDirError = work_dir ? validateWorkDir(work_dir) : undefined
      if (workDirError) return textResponse(`Error: ${workDirError}`, true)
      const includeThinkingValue = include_thinking ?? false
      const selectedProvider = (provider ?? 'kimi') as ProviderId
      const appendReporter = (append: (text: string) => void) => (event: ProgressEvent) => append(formatTaskLogLine(event))

      const runAgent = async (signal?: AbortSignal, onProgress?: (event: ProgressEvent) => void) => {
        if (selectedProvider === 'minimax') {
          return runMinimaxCode({
            prompt,
            workDir: work_dir,
            sessionId: session_id,
            edit,
            detailLevel: detail_level ?? 'normal',
            includeThinking: includeThinkingValue,
            timeoutMs: timeout_ms,
            signal,
            onProgress,
          })
        }
        return runKimiCodeAgent({
          prompt,
          workDir: work_dir,
          sessionId: session_id,
          edit,
          detailLevel: detail_level ?? 'normal',
          includeThinking: includeThinkingValue,
          timeoutMs: timeout_ms,
          signal,
          onProgress,
        })
      }

      if (background) {
        const taskKind = selectedProvider === 'minimax' ? 'minimax-code' : 'acp-code'
        const task = taskStore.create(taskKind, async (_signal, append) => {
          const result = await runAgent(_signal, appendReporter(append))
          if (!result.ok) {
            const resume = result.resumable && result.sessionId
              ? ` (resumable — call agent_code again with session_id=${result.sessionId})`
              : ''
            throw new Error(`${result.error ?? 'agent_code task failed'}${resume}`)
          }
          const metadata = { ...(result.metadata ?? {}) }
          if (!('sessionId' in metadata)) {
            metadata.sessionId = result.sessionId
          }
          return { output: result.text, metadata }
        })
        return jsonResponse(task)
      }

      const result = await runAgent(extra?.signal, createMcpProgressReporter(extra))
      const envelope = buildTerminalEnvelope({ ...result, resumeToolName: 'agent_code' })
      if (result.ok) {
        const thinkingTag = selectedProvider === 'kimi' ? 'kimi-thinking' : 'minimax-thinking'
        const body = wrapThinking(result.text, result.thinking, includeThinkingValue, thinkingTag)
        const tail = `\n\n${formatTerminalEnvelope(envelope)}`
        const budget = Math.max(0, maxChars(max_output_tokens) - tail.length)
        const guardedBody = guardResponse(body, { maxChars: budget }).text
        return { content: [{ type: 'text' as const, text: `${guardedBody}${tail}` }], isError: false }
      }
      return textResponse(`${formatTerminalEnvelope(envelope)}\n\nError: ${result.error}`, true, maxChars(max_output_tokens))
    },
  )

  server.tool(
    'agent_cycle',
    'Iterative dev cycle: a coder agent implements, an independent reviewer agent (separate session) reviews the diff, and the loop repeats until the reviewer approves or max_iterations is reached. Recommended for code-writing tasks with provider=minimax. Both roles default to the same provider; override per role with coder_provider/reviewer_provider.',
    {
      prompt: z.string().describe('The coding task to implement.'),
      work_dir: z.string().describe('Absolute path to the codebase root directory.'),
      max_iterations: z.number().int().min(1).max(10).describe('Maximum coder→reviewer iterations (1-10). The caller controls the budget.'),
      provider: z.enum(['kimi', 'minimax']).optional().describe("Provider for both roles. Default: 'kimi'."),
      coder_provider: z.enum(['kimi', 'minimax']).optional().describe('Override the coder provider.'),
      reviewer_provider: z.enum(['kimi', 'minimax']).optional().describe('Override the reviewer provider.'),
      edit: z.boolean().optional().describe('Allow the coder to modify files. Default: true (the reviewer is always read-only).'),
      background: z.boolean().optional().describe('Run as a tracked background task; manage via agent_tasks. Default false (foreground).'),
      detail_level: z.enum(['summary', 'normal', 'detailed']).optional(),
      timeout_ms: z.number().int().positive().optional().describe('Timeout per individual agent run (not the whole cycle).'),
    },
    { title: 'Run a coder/reviewer dev cycle', destructiveHint: true },
    async ({ prompt, work_dir, max_iterations, provider, coder_provider, reviewer_provider, edit, background, detail_level, timeout_ms }, extra) => {
      const workDirError = work_dir ? validateWorkDir(work_dir) : undefined
      if (workDirError) return textResponse(`Error: ${workDirError}`, true)
      const baseProvider = (provider ?? 'kimi') as ProviderId
      const cycleOptions = {
        prompt,
        workDir: work_dir,
        maxIterations: max_iterations,
        coderProvider: (coder_provider ?? baseProvider) as ProviderId,
        reviewerProvider: (reviewer_provider ?? baseProvider) as ProviderId,
        edit,
        detailLevel: detail_level ?? ('normal' as const),
        timeoutMs: timeout_ms,
      }
      const appendReporter = (append: (text: string) => void) => (event: ProgressEvent) => append(formatTaskLogLine(event))

      if (background) {
        const task = taskStore.create('agent-cycle', async (signal, append) => {
          const result = await runAgentCycle({ ...cycleOptions, signal, onProgress: appendReporter(append) })
          if (!result.ok && result.finalVerdict === 'incomplete') {
            throw new Error(`${result.error ?? 'agent_cycle failed'}${result.coderSessionId ? ` (coder session: ${result.coderSessionId})` : ''}`)
          }
          return {
            output: result.text,
            metadata: {
              finalVerdict: result.finalVerdict,
              iterationsUsed: result.iterationsUsed,
              coderSessionId: result.coderSessionId,
              reviewerSessionId: result.reviewerSessionId,
            },
          }
        })
        return jsonResponse(task)
      }

      const result = await runAgentCycle({ ...cycleOptions, signal: extra?.signal, onProgress: createMcpProgressReporter(extra) })
      const envelope = buildTerminalEnvelope({
        ok: result.ok,
        error: result.error,
        sessionId: result.coderSessionId,
        resumeToolName: 'agent_code',
      })
      const tail = `\n\n${formatTerminalEnvelope(envelope)}${result.reviewerSessionId ? `\nReviewer session: ${result.reviewerSessionId}` : ''}`
      const budget = Math.max(0, DEFAULT_TOOL_MAX_CHARS - tail.length)
      const guardedBody = guardResponse(result.text, { maxChars: budget }).text
      return { content: [{ type: 'text' as const, text: `${guardedBody}${tail}` }], isError: !result.ok }
    },
  )

  server.tool(
    'agent_sessions',
    'List sessions across providers: Kimi (CLI catalog + ACP) and MiniMax (Ladder-owned session store).',
    {
      provider: z.enum(['kimi', 'minimax', 'all']).optional().describe("Provider filter. Default: 'all'."),
      work_dir: z.string().optional().describe('Filter sessions by working directory path.'),
      limit: z.number().int().min(1).optional().describe('Max sessions per provider. Default: 20.'),
    },
    { title: 'List provider sessions', readOnlyHint: true },
    async ({ provider, work_dir, limit }) => {
      const effectiveProvider = provider ?? 'all'
      const effectiveLimit = limit ?? 20
      const result: Record<string, unknown> = {}

      if (effectiveProvider === 'minimax' || effectiveProvider === 'all') {
        result.minimax = await listMinimaxSessions({ workDir: work_dir, limit: effectiveLimit })
      }
      if (effectiveProvider === 'kimi' || effectiveProvider === 'all') {
        const cli = listSessions({ workDir: work_dir, limit: effectiveLimit })
        const acpResult = await listAcpSessions({ limit: effectiveLimit, workDir: work_dir })
        let acp: unknown
        if (acpResult.ok) {
          try {
            acp = JSON.parse(acpResult.text) as unknown
          } catch {
            acp = { error: 'ACP sessions response is not valid JSON', raw: acpResult.text }
          }
        } else {
          acp = { error: acpResult.error }
        }
        result.kimi = { cli, acp }
      }
      return jsonResponse(result)
    },
  )

  server.tool(
    'agent_status',
    'Installation, auth, and diagnostics for Kimi and MiniMax.',
    {
      detail: z.enum(['basic', 'full']).optional().describe("Detail level: 'basic' or 'full'. Default: 'basic'."),
    },
    { title: 'Provider installation and auth diagnostics', readOnlyHint: true },
    async ({ detail }) => {
      const [kimi, minimax] = await Promise.all([getKimiStatus(), getMinimaxStatus()])
      const apiConfigured = isApiConfigured()
      const lines = [
        '## Ladder_mcp server',
        `- Version: ${VERSION}`,
        '',
        '## Kimi',
        `- Installed: ${kimi.installed ? 'Yes' : 'No'}`,
        `- Binary: ${kimi.binPath ? `\`${kimi.binPath}\`` : 'Not found'}`,
        `- Version: ${kimi.version ?? '(unable to detect)'}`,
        `- Session authenticated: ${kimi.authenticated ? 'Yes' : 'No'}`,
        `- Catalog Found: ${kimi.catalogFound ? 'Yes' : 'No'}`,
        `- Catalog: \`${kimi.catalogPath}\``,
        `- Credentials Found: ${kimi.credentialsFound ? 'Yes' : 'No'}`,
        `- Config Found: ${kimi.configFound ? 'Yes' : 'No'}`,
        `- API configured: ${apiConfigured ? 'Yes' : 'No'}`,
        '',
        '## MiniMax',
        `- Installed: ${minimax.installed ? 'Yes' : 'No'}`,
        `- Binary: ${minimax.binPath ? `\`${minimax.binPath}\`` : 'Not found'}`,
        `- Version: ${minimax.version ?? '(unable to detect)'}`,
        `- Authenticated: ${minimax.authenticated ? 'Yes' : 'No'}`,
      ]
      if (detail === 'full') {
        const sessionsDir = getMinimaxSessionsDir()
        const sessions = await listMinimaxSessions({ limit: 100 })
        lines.push(
          `- Sessions dir: \`${sessionsDir}\``,
          `- Stored sessions: ${sessions.length}${sessions.length ? ` (latest: ${sessions[0].id}, updated ${sessions[0].updatedAt})` : ''}`,
        )
      }
      lines.push(
        '',
        '## Available tools',
        `- kimi_code: ${kimi.installed && kimi.authenticated ? 'available' : 'unavailable (install/authenticate Kimi CLI)'}`,
        `- kimi_ask / agent_ask (provider=kimi): ${apiConfigured ? 'available' : 'unavailable (set KIMI_API_KEY or api_key in ~/.kimi-code/config.toml)'}`,
        `- agent_ask (provider=minimax): ${minimax.installed && minimax.authenticated ? 'available' : 'unavailable (install/authenticate mmx CLI)'}`,
        `- agent_code (provider=kimi): ${kimi.installed && kimi.authenticated ? 'available' : 'unavailable (install/authenticate Kimi CLI)'}`,
        `- agent_code (provider=minimax): ${minimax.installed && minimax.authenticated ? 'available' : 'unavailable (install/authenticate mmx CLI)'}`,
        `- agent_cycle: available when the chosen coder/reviewer providers above are available`,
      )
      if (kimi.error) lines.push('', `Kimi action required: ${kimi.error}`)
      if (minimax.error) lines.push('', `MiniMax action required: ${minimax.error}`)
      return textResponse(lines.join('\n'), Boolean(kimi.error) || Boolean(minimax.error))
    },
  )

  server.tool(
    'agent_tasks',
    'Manage background work across providers: wait, status, output, or cancel.',
    {
      action: z.enum(['wait', 'status', 'output', 'cancel']).describe("Action: 'wait' (block until finished), 'status' (compact metadata), 'output' (paginated body), or 'cancel'."),
      task_id: z.string().optional().describe('Omit for status to list all tasks. Required for wait and output.'),
      session_id: z.string().optional().describe('Cancel an ACP session instead of a task (action=cancel).'),
      mode: z.enum(['final', 'full']).optional().describe("output mode: 'final' returns the last line(s), 'full' returns a slice. Default: 'full'."),
      offset: z.number().int().min(0).optional().describe("output full-mode: line offset. Default: 0."),
      limit: z.number().int().min(1).optional().describe("output/wait: max lines to return. Default: 100 (output), 20 (wait)."),
      timeout_ms: z.number().int().positive().optional().describe('wait: max time to block. Default: 20 minutes.'),
    },
    { title: 'Manage background tasks', destructiveHint: true },
    async (args, extra) => handleTasks(args, extra),
  )
}
