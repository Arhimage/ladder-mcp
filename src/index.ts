#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { maxChars, validateWorkDir } from './input-validation.js'
import { getKimiStatus } from './environment.js'
import { runKimiApi, isApiConfigured } from './kimi-api.js'
import { listSessions } from './session-store.js'
import { cancelAcpSession, listAcpSessions, runAcpPrompt, ACP_TIMEOUT_FLOOR_MS } from './transports/acp.js'
import { DEFAULT_TOOL_MAX_CHARS, formatTerminalEnvelope, guardResponse, type TerminalEnvelope } from './response.js'
import {
  exportKimiSession,
  getKimiCapabilities,
  listKimiProviders,
  runKimiDoctor,
  visualizeSession,
} from './transports/cli-admin.js'
import { generateMcpConfig } from './kimi-mcp-config.js'
import { buildBudgetProbeGuide, getDesktopStatus } from './desktop-work.js'
import { taskStore } from './task-store.js'
import { combineReporters, createMcpProgressReporter, formatTaskLogLine } from './progress.js'
import { VERSION } from './version.js'
import type { DetailLevel, ProgressEvent } from './types.js'

const server = new McpServer({
  name: 'kimi-code',
  version: VERSION,
})

const FORMAT_INSTRUCTIONS: Record<DetailLevel, string> = {
  summary: `
OUTPUT FORMAT CONSTRAINTS:
- Maximum ~2000 words. Be extremely concise.
- Use bullet points, not paragraphs.
- List file paths and one-line descriptions only.
- No code snippets.
- Structure: ## Overview -> ## Key Findings -> ## File Index`,
  normal: `
OUTPUT FORMAT CONSTRAINTS:
- Maximum ~5000 words. Be concise but thorough.
- Use structured sections with markdown headers.
- Include function/class signatures, not full implementations.
- Reference file paths and line numbers when useful.
- Structure: ## Overview -> ## Architecture -> ## Key Findings -> ## File Details`,
  detailed: `
OUTPUT FORMAT CONSTRAINTS:
- Maximum ~15000 words.
- Include relevant snippets only when they materially help.
- Explain dependency relationships and data flow.`,
}

const AI_CONSUMER_NOTICE = `
IMPORTANT: Your response will be consumed by another AI model with limited context. Prioritize density, concrete file references, and structured markdown.`

function wrapPrompt(prompt: string, detailLevel: DetailLevel): string {
  return `${prompt}\n${FORMAT_INSTRUCTIONS[detailLevel]}\n${AI_CONSUMER_NOTICE}`
}

function wrapCodePrompt(prompt: string, detailLevel: DetailLevel, edit: boolean | undefined): string {
  const editGuard = edit
    ? 'EDIT MODE: You may modify files when needed to satisfy the request.'
    : 'READ-ONLY MODE: Do not modify files. Analyze only and report findings.'
  return `${editGuard}\n\n${wrapPrompt(prompt, detailLevel)}`
}

function textResponse(text: string, isError = false, maxChars?: number) {
  const guarded = guardResponse(text, maxChars !== undefined ? { maxChars } : undefined)
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
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        truncated: true,
        originalChars: serialized.length,
        maxChars,
        message: 'JSON response exceeded the size guard. Use pagination, filters, or a smaller limit to retrieve a smaller valid JSON response.',
      }, null, 2),
    }],
    isError,
  }
}

function buildResponse(text: string, thinking: string | undefined, includeThinking: boolean): string {
  return thinking && includeThinking ? `<kimi-thinking>\n${thinking}\n</kimi-thinking>\n\n${text}` : text
}

function buildTerminalEnvelope(result: { ok: boolean; text?: string; error?: string; sessionId?: string; resumable?: boolean; exitCode?: number; exitClass?: string; stderrTail?: string; affectedFiles?: string[] }): TerminalEnvelope {
  const status = result.ok ? 'success' : result.resumable ? 'timeout' : result.error?.toLowerCase().includes('cancel') ? 'cancel' : 'error'
  return {
    status,
    sessionId: result.sessionId,
    resumable: result.resumable,
    exitCode: result.exitCode,
    exitClass: result.exitClass,
    stderrTail: result.stderrTail,
    affectedFiles: result.affectedFiles,
    ...(result.resumable
      ? {
          continuation: {
            instruction: 'The Kimi session timed out but may still be active. Continue the same session by calling kimi_code with new_session=false and the session_id below; do not start a new task or do the work yourself. Resume is best-effort.',
            newSession: false,
            sessionId: result.sessionId,
          },
        }
      : {}),
  }
}

function resolveDefaultServerCommand(): { command: string; args: string[] } {
  const distIndex = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'index.js')
  return { command: process.execPath, args: [distIndex] }
}

server.tool(
  'kimi_code',
  `Agentic work in a repository: analyze and edit files through the ACP JSON-RPC transport. If the call times out, the Kimi session may still be active. To continue, call kimi_code again with new_session=false and the session_id returned in the response. Do not start a new task or perform the work yourself. Resume is best-effort and not guaranteed.`,
  {
    prompt: z.string().describe('The analysis or coding prompt for Kimi.'),
    work_dir: z.string().describe('Absolute path to the codebase root directory.'),
    session_id: z.string().optional().describe('Explicit Kimi session id to resume.'),
    new_session: z.boolean().optional().describe('Start fresh instead of continuing the last session. Default: false.'),
    edit: z.boolean().optional().describe('Allow file modifications. Default: false (analysis-only). When false/omitted the ACP bridge enforces read-only: it prepends a read-only guard AND rejects fs writes / mutating tool permissions at the proxy (reads still allowed). Set true to permit edits.'),
    background: z.boolean().optional().describe('Track as a long-running background task. Every progress event (including each action) is appended to the task log, readable via kimi_tasks — the full accumulating transcript, unlike the single overwriting live-progress line of a foreground call.'),
    session_mode: z.enum(['new', 'load', 'resume']).optional().describe("ACP session mode. Default: inferred from session_id/new_session."),
    detail_level: z.enum(['summary', 'normal', 'detailed']).optional(),
    max_output_tokens: z.number().optional(),
    include_thinking: z.boolean().optional(),
    timeout_ms: z.number().int().positive().optional().describe(`Optional timeout in milliseconds. The ACP transport enforces a floor of ${ACP_TIMEOUT_FLOOR_MS / 60_000} minutes; any smaller value is raised to the floor. Larger values are allowed.`),
  },
  { title: 'Run Kimi agentic code work', destructiveHint: true },
  async ({ prompt, work_dir, session_id, new_session, edit, background, session_mode, detail_level, max_output_tokens, include_thinking, timeout_ms }, extra) => {
    const workDirError = work_dir ? validateWorkDir(work_dir) : undefined
    if (workDirError) return textResponse(`Error: ${workDirError}`, true)
    const includeThinkingValue = include_thinking ?? false
    const appendReporter = (append: (text: string) => void) => (event: ProgressEvent) => append(formatTaskLogLine(event))
    const wrappedPrompt = wrapCodePrompt(prompt, detail_level ?? 'normal', edit)

    const defaultAcpSessionMode = session_mode ?? (session_id ? 'resume' : 'new')
    const runAcp = async (signal?: AbortSignal, onProgress?: (event: ProgressEvent) => void) => runAcpPrompt({
      prompt: wrappedPrompt,
      workDir: work_dir,
      sessionId: session_id,
      sessionMode: defaultAcpSessionMode,
      timeoutMs: timeout_ms,
      signal,
      onProgress,
      includeThinking: includeThinkingValue,
      readOnly: edit !== true,
    })

    if (background) {
      const task = taskStore.create('acp-code', async (_signal, append) => {
        const result = await runAcp(_signal, appendReporter(append))
        if (!result.ok) {
          const resume = result.resumable && result.sessionId
            ? ` (resumable — continue with new_session=false, session_id=${result.sessionId})`
            : ''
          throw new Error(`${result.error ?? 'ACP code task failed'}${resume}`)
        }
        const metadata = { ...(result.metadata ?? {}) }
        if (!('sessionId' in metadata)) {
          metadata.sessionId = result.sessionId
        }
        return { output: result.text, metadata }
      })
      return jsonResponse(task)
    }

    const result = await runAcp(extra?.signal, createMcpProgressReporter(extra))
    const envelope = buildTerminalEnvelope(result)
    if (result.ok) {
      const body = buildResponse(result.text, result.thinking, includeThinkingValue)
      const tail = `\n\n${formatTerminalEnvelope(envelope)}`
      const budget = Math.max(0, maxChars(max_output_tokens) - tail.length)
      const guardedBody = guardResponse(body, { maxChars: budget }).text
      return { content: [{ type: 'text' as const, text: `${guardedBody}${tail}` }], isError: false }
    }
    return textResponse(`${formatTerminalEnvelope(envelope)}\n\nError: ${result.error}`, true, maxChars(max_output_tokens))
  },
)

server.tool(
  'kimi_ask',
  'Stateless question or independent review. Text only, no repo, no edits.',
  {
    prompt: z.string().describe('The question to ask or the focus for verification.'),
    context: z.string().optional().describe('Material to examine (switches to verify mode).'),
    role: z.string().optional().describe('Reviewer persona override for verify mode.'),
    max_output_tokens: z.number().optional(),
    include_thinking: z.boolean().optional(),
    timeout_ms: z.number().int().positive().optional(),
  },
  { title: 'Ask Kimi a stateless question', readOnlyHint: true },
  async ({ prompt, context, role, max_output_tokens, include_thinking, timeout_ms }) => {
    const includeThinkingValue = include_thinking ?? false
    if (context) {
      const focus = prompt.trim() || 'Independently verify correctness. Surface bugs, edge cases, security issues, and concrete improvements.'
      const system = role?.trim() || 'You are a meticulous, independent senior engineer. Be skeptical, specific, and actionable.'
      const verifyPrompt = `## Your task\n${focus}\n\n## Material to verify\n${context}\n${AI_CONSUMER_NOTICE}`
      const result = await runKimiApi({ prompt: verifyPrompt, system, timeoutMs: timeout_ms ?? 300_000, maxOutputChars: maxChars(max_output_tokens) })
      if (!result.ok) return textResponse(`Error: ${result.error}`, true)
      return textResponse(buildResponse(result.text, result.thinking, includeThinkingValue), false, maxChars(max_output_tokens))
    }

    const result = await runKimiApi({ prompt, timeoutMs: timeout_ms ?? 120_000, maxOutputChars: maxChars(max_output_tokens) })
    if (!result.ok) return textResponse(`Error: ${result.error}`, true)
    return textResponse(buildResponse(result.text, result.thinking, includeThinkingValue), false, maxChars(max_output_tokens))
  },
)

server.tool(
  'kimi_sessions',
  'List/inspect Kimi sessions from the CLI catalog, ACP, or both.',
  {
    work_dir: z.string().optional().describe('Filter sessions by working directory path.'),
    limit: z.number().optional().describe('Max sessions to return. Default: 20.'),
    source: z.enum(['cli', 'acp', 'all']).optional().describe("Source: 'cli', 'acp', or 'all'. Default: 'all'."),
  },
  { title: 'List Kimi sessions', readOnlyHint: true },
  async ({ work_dir, limit, source }) => {
    const effectiveSource = source ?? 'all'
    const effectiveLimit = limit ?? 20

    if (effectiveSource === 'cli') {
      const sessions = listSessions({ workDir: work_dir, limit: effectiveLimit })
      return sessions.length ? jsonResponse(sessions) : textResponse('No Kimi sessions found.')
    }

    if (effectiveSource === 'acp') {
      const result = await listAcpSessions({ limit: effectiveLimit, workDir: work_dir })
      if (!result.ok) return textResponse(`Error: ${result.error}`, true)
      try {
        return jsonResponse(JSON.parse(result.text) as unknown)
      } catch {
        return textResponse(result.text)
      }
    }

    const [cliSessions, acpResult] = await Promise.all([
      Promise.resolve(listSessions({ workDir: work_dir, limit: effectiveLimit })),
      listAcpSessions({ limit: effectiveLimit, workDir: work_dir }),
    ])
    let acpValue: unknown
    if (acpResult.ok) {
      try {
        acpValue = JSON.parse(acpResult.text) as unknown
      } catch {
        acpValue = { error: 'ACP sessions response is not valid JSON', raw: acpResult.text }
      }
    } else {
      acpValue = { error: acpResult.error }
    }
    const combined = { cli: cliSessions, acp: acpValue }
    return jsonResponse(combined)
  },
)

server.tool(
  'kimi_tasks',
  'Manage background work: status (compact metadata), output (paginated final/full log), or cancel. By default status returns only metadata; the full transcript is opt-in via action=output.',
  {
    action: z.enum(['status', 'output', 'cancel']).describe("Action: 'status' (metadata only), 'output' (paginated body), or 'cancel'."),
    task_id: z.string().optional().describe('Omit for status to list all tasks. Required for output.'),
    session_id: z.string().optional().describe('Cancel an ACP session instead of a task (action=cancel).'),
    mode: z.enum(['final', 'full']).optional().describe("output mode: 'final' returns the last line(s), 'full' returns a slice. Default: 'full'."),
    offset: z.number().int().min(0).optional().describe("output full-mode: line offset. Default: 0."),
    limit: z.number().int().min(1).optional().describe("output mode: max lines to return. Default: 100."),
  },
  { title: 'Manage background Kimi tasks', destructiveHint: true },
  async ({ action, task_id, session_id, mode, offset, limit }) => {
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
    if (task_id) {
      const task = await taskStore.cancel(task_id)
      return task ? jsonResponse(task) : textResponse(`Task not found: ${task_id}`, true)
    }
    if (session_id) {
      const result = await cancelAcpSession(session_id)
      return jsonResponse(result, !result.ok)
    }
    return textResponse('Provide task_id or session_id.', true)
  },
)

server.tool(
  'kimi_status',
  'Installation, auth, and diagnostics.',
  {
    detail: z.enum(['basic', 'full']).optional().describe("Detail level: 'basic' or 'full'. Default: 'basic'."),
    doctor_target: z.enum(['config', 'tui']).optional().describe("Target for the doctor subcall when detail='full'. Default: 'config'."),
    doctor_path: z.string().optional().describe("Optional config/tui path for the doctor subcall when detail='full'."),
  },
  { title: 'Kimi installation and auth diagnostics', readOnlyHint: true },
  async ({ detail, doctor_target, doctor_path }) => {
    const status = await getKimiStatus()
    const apiConfigured = isApiConfigured()
    const lines = [
      '## Ladder_mcp server',
      `- Version: ${VERSION}`,
      '',
      '## Kimi CLI / ACP session auth',
      `- Installed: ${status.installed ? 'Yes' : 'No'}`,
      `- Binary: ${status.binPath ? `\`${status.binPath}\`` : 'Not found'}`,
      `- Version: ${status.version ?? '(unable to detect)'}`,
      `- Session authenticated (for kimi_code): ${status.authenticated ? 'Yes' : 'No'}`,
      `- Catalog Found: ${status.catalogFound ? 'Yes' : 'No'}`,
      `- Catalog: \`${status.catalogPath}\``,
      `- Credentials Found: ${status.credentialsFound ? 'Yes' : 'No'}`,
      `- Config Found: ${status.configFound ? 'Yes' : 'No'}`,
      '',
      '## Kimi Code API auth (for kimi_ask)',
      `- Configured: ${apiConfigured ? 'Yes' : 'No'}`,
      '',
      '## Available tools in this state',
      `- kimi_code: ${status.installed && status.authenticated ? 'available' : 'unavailable (install/authenticate Kimi CLI)'}`,
      `- kimi_ask: ${apiConfigured ? 'available' : 'unavailable (set KIMI_API_KEY or api_key in ~/.kimi-code/config.toml)'}`,
      `- kimi_sessions, kimi_tasks, kimi_status, kimi_setup: ${status.installed ? 'available' : 'unavailable'}`,
    ]
    if (status.error) lines.push('', `Action required: ${status.error}`)

    let subcallsFailed = false
    if (detail === 'full') {
      const [capabilities, doctor, providers] = await Promise.all([
        getKimiCapabilities(),
        runKimiDoctor(doctor_target ?? 'config', doctor_path),
        listKimiProviders(),
      ])
      const isFailedResult = (value: unknown): boolean => typeof value === 'object' && value !== null && 'ok' in value && (value as { ok?: boolean }).ok === false
      if (isFailedResult(doctor)) subcallsFailed = true
      if (!Array.isArray(providers) && isFailedResult(providers)) subcallsFailed = true
      lines.push(
        '',
        '## Capabilities',
        JSON.stringify(capabilities, null, 2),
        '',
        '## Doctor',
        JSON.stringify(doctor, null, 2),
        '',
        '## Providers',
        JSON.stringify(providers, null, 2),
      )
    }

    return textResponse(lines.join('\n'), Boolean(status.error) || subcallsFailed)
  },
)

server.tool(
  'kimi_setup',
  'Generate the Kimi-hosted MCP config entry for Ladder_mcp.',
  {
    scope: z.enum(['project', 'user']).optional(),
    project_dir: z.string().optional(),
    server_name: z.string().optional(),
    write: z.boolean().optional().describe('When false/omitted, only preview the merged config.'),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
  },
  { title: 'Generate Kimi MCP config entry', destructiveHint: true },
  async ({ scope, project_dir, server_name, write, command, args }) => {
    const defaults = resolveDefaultServerCommand()
    const result = generateMcpConfig({
      scope,
      projectDir: project_dir,
      serverName: server_name,
      write: write ?? false,
      command: command ?? defaults.command,
      args: args ?? defaults.args,
    })
    return jsonResponse(result)
  },
)

if (process.env.LADDER_EXPERIMENTAL === '1') {
  server.tool(
    'kimi_export_session',
    'Export a Kimi session ZIP. Requires explicit output_path and excludes the global diagnostic log by default.',
    {
      output_path: z.string().describe('Explicit ZIP output path.'),
      session_id: z.string().optional().describe('Session id to export; defaults to most recent Kimi session.'),
      include_global_log: z.boolean().optional().describe('Include active global diagnostic log. Default: false.'),
      overwrite_existing: z.boolean().optional().describe('Overwrite output_path if it already exists. Default: false.'),
    },
    { title: 'Export Kimi session ZIP', destructiveHint: true },
    async ({ output_path, session_id, include_global_log, overwrite_existing }) => {
      const result = await exportKimiSession({
        outputPath: output_path,
        sessionId: session_id,
        includeGlobalLog: include_global_log ?? false,
        overwriteExisting: overwrite_existing ?? false,
      })
      return jsonResponse(result, !result.ok)
    },
  )

  server.tool(
    'kimi_visualize_session',
    'Preview or launch Kimi session visualizer on localhost using `kimi vis --no-open`.',
    {
      session_id: z.string().optional(),
      host: z.enum(['127.0.0.1', 'localhost', '::1']).optional().describe('Localhost host to bind. Default: 127.0.0.1.'),
      port: z.number().int().min(1).max(65535).optional().describe('Port to bind. Default: 58628.'),
      launch: z.boolean().optional().describe('Actually start the visualizer process. Default: false.'),
    },
    { title: 'Launch Kimi session visualizer', destructiveHint: true },
    async ({ session_id, host, port, launch }) => {
      try {
        return jsonResponse(visualizeSession({ sessionId: session_id, host, port, launch }))
      } catch (error) {
        return textResponse(`Error: ${error instanceof Error ? error.message : String(error)}`, true)
      }
    },
  )

  server.tool(
    'kimi_desktop_status',
    'Experimental read-only Kimi Desktop Work status probe. Does not read token stores or replay web auth.',
    {},
    { title: 'Read Kimi Desktop Work status', readOnlyHint: true },
    async () => jsonResponse(await getDesktopStatus()),
  )

  server.tool(
    'kimi_budget_probe',
    'Experimental guided budget-separation evidence workflow. Does not submit desktop Work tasks.',
    {
      include_cli_probe_note: z.boolean().optional(),
    },
    { title: 'Budget-separation evidence guide', readOnlyHint: true },
    async ({ include_cli_probe_note }) => textResponse(buildBudgetProbeGuide(include_cli_probe_note ?? false)),
  )
}

export { server }

const isMain = process.argv[1] === fileURLToPath(import.meta.url)
if (isMain) {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
