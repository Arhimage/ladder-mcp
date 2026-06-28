#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { maxChars, validateWorkDir } from './input-validation.js'
import { getKimiStatus } from './environment.js'
import { runKimiApi, isApiConfigured } from './kimi-api.js'
import { runKimi } from './kimi-runner.js'
import { listSessions } from './session-store.js'
import { cancelAcpSession, listAcpSessions, runAcpPrompt } from './transports/acp.js'
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

function textResponse(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], isError }
}

function buildResponse(text: string, thinking: string | undefined, includeThinking: boolean): string {
  return thinking && includeThinking ? `<kimi-thinking>\n${thinking}\n</kimi-thinking>\n\n${text}` : text
}

function resolveDefaultServerCommand(): { command: string; args: string[] } {
  const distIndex = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'index.js')
  return { command: process.execPath, args: [distIndex] }
}

server.tool(
  'kimi_code',
  'Agentic work in a repository: analyze and edit files. Defaults to ACP transport.',
  {
    prompt: z.string().describe('The analysis or coding prompt for Kimi.'),
    work_dir: z.string().describe('Absolute path to the codebase root directory.'),
    session_id: z.string().optional().describe('Explicit Kimi session id to resume.'),
    new_session: z.boolean().optional().describe('Start fresh instead of continuing the last session. Default: false.'),
    edit: z.boolean().optional().describe('Allow file modifications. Default: false (analysis-only intent). On Kimi 0.20.1 this is prompt-enforced (advisory): when false/omitted the prompt is prefixed with a read-only guard, but the CLI itself provides no hard read-only flag for -p mode.'),
    background: z.boolean().optional().describe('Track as a long-running background task. Every progress event (including each action) is appended to the task log, readable via kimi_tasks — the full accumulating transcript, unlike the single overwriting live-progress line of a foreground call.'),
    transport: z.enum(['cli', 'acp']).optional().describe("How the server drives Kimi. Both edit files and resume sessions; they differ in robustness and live-progress detail. 'acp' (default): persistent JSON-RPC session that emits granular live progress (tool calls, plan steps) and supports interactive permission prompts, but is heavier and more fragile. 'cli': one-shot process, most robust on Windows, but live progress is coarse — only streaming-output volume, no per-action lines. Prefer 'acp' as the default for most work; choose 'cli' explicitly when you need the most robust one-shot process on Windows."),
    session_mode: z.enum(['new', 'load', 'resume']).optional().describe("ACP session mode when transport='acp'. Default: inferred from session_id/new_session."),
    detail_level: z.enum(['summary', 'normal', 'detailed']).optional(),
    max_output_tokens: z.number().optional(),
    include_thinking: z.boolean().optional(),
    timeout_ms: z.number().int().positive().optional(),
  },
  async ({ prompt, work_dir, session_id, new_session, edit, background, transport, session_mode, detail_level, max_output_tokens, include_thinking, timeout_ms }, extra) => {
    const workDirError = work_dir ? validateWorkDir(work_dir) : undefined
    if (workDirError) return textResponse(`Error: ${workDirError}`, true)
    const includeThinkingValue = include_thinking ?? false
    const effectiveTransport = transport ?? 'acp'
    const appendReporter = (append: (text: string) => void) => (event: ProgressEvent) => append(formatTaskLogLine(event))

    if (effectiveTransport === 'cli') {
      if (background) {
        const task = taskStore.create('cli-code', async (_signal, append) => {
          const result = await runKimi({
            prompt: wrapPrompt(prompt, detail_level ?? 'normal'),
            workDir: work_dir,
            sessionId: session_id,
            continueLast: !session_id && new_session !== true,
            edit,
            timeoutMs: timeout_ms ?? 600_000,
            maxOutputChars: maxChars(max_output_tokens),
            includeThinking: includeThinkingValue,
            onProgress: appendReporter(append),
            signal: _signal,
          })
          if (!result.ok) throw new Error(result.error ?? 'CLI code task failed')
          return { output: result.text, metadata: { sessionId: result.sessionId } }
        })
        return textResponse(JSON.stringify(task, null, 2))
      }

      const result = await runKimi({
        prompt: wrapPrompt(prompt, detail_level ?? 'normal'),
        workDir: work_dir,
        sessionId: session_id,
        continueLast: !session_id && new_session !== true,
        edit,
        timeoutMs: timeout_ms ?? 600_000,
        maxOutputChars: maxChars(max_output_tokens),
        includeThinking: includeThinkingValue,
        onProgress: createMcpProgressReporter(extra),
        signal: extra?.signal,
      })
      if (!result.ok) return textResponse(`Error: ${result.error}`, true)
      const sessionLine = result.sessionId ? `\n\nSession: ${result.sessionId}` : ''
      return textResponse(`${buildResponse(result.text, result.thinking, includeThinkingValue)}${sessionLine}`)
    }

    const defaultAcpSessionMode = session_mode ?? (session_id ? 'resume' : 'new')
    const runAcp = async (signal?: AbortSignal, onProgress?: (event: ProgressEvent) => void) => runAcpPrompt({
      prompt,
      workDir: work_dir,
      sessionId: session_id,
      sessionMode: defaultAcpSessionMode,
      timeoutMs: timeout_ms,
      signal,
      onProgress,
    })

    if (background) {
      const task = taskStore.create('acp-code', async (_signal, append) => {
        const result = await runAcp(_signal, combineReporters(appendReporter(append), createMcpProgressReporter(extra)))
        if (!result.ok) throw new Error(result.error ?? 'ACP code task failed')
        const metadata = { ...(result.metadata ?? {}) }
        if (!('sessionId' in metadata)) {
          metadata.sessionId = result.sessionId
        }
        return { output: result.text, metadata }
      })
      return textResponse(JSON.stringify(task, null, 2))
    }

    const result = await runAcp(extra?.signal, createMcpProgressReporter(extra))
    return textResponse(JSON.stringify(result, null, 2), !result.ok)
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
  async ({ prompt, context, role, max_output_tokens, include_thinking, timeout_ms }) => {
    const includeThinkingValue = include_thinking ?? false
    if (context) {
      const focus = prompt.trim() || 'Independently verify correctness. Surface bugs, edge cases, security issues, and concrete improvements.'
      const system = role?.trim() || 'You are a meticulous, independent senior engineer. Be skeptical, specific, and actionable.'
      const verifyPrompt = `## Your task\n${focus}\n\n## Material to verify\n${context}\n${AI_CONSUMER_NOTICE}`
      const result = await runKimiApi({ prompt: verifyPrompt, system, timeoutMs: timeout_ms ?? 300_000, maxOutputChars: maxChars(max_output_tokens) })
      if (!result.ok) return textResponse(`Error: ${result.error}`, true)
      return textResponse(buildResponse(result.text, result.thinking, includeThinkingValue))
    }

    const result = await runKimiApi({ prompt, timeoutMs: timeout_ms ?? 120_000, maxOutputChars: maxChars(max_output_tokens) })
    if (!result.ok) return textResponse(`Error: ${result.error}`, true)
    return textResponse(buildResponse(result.text, result.thinking, includeThinkingValue))
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
  async ({ work_dir, limit, source }) => {
    const effectiveSource = source ?? 'all'
    const effectiveLimit = limit ?? 20

    if (effectiveSource === 'cli') {
      const sessions = listSessions({ workDir: work_dir, limit: effectiveLimit })
      return textResponse(sessions.length ? JSON.stringify(sessions, null, 2) : 'No Kimi sessions found.')
    }

    if (effectiveSource === 'acp') {
      const result = await listAcpSessions({ limit: effectiveLimit, workDir: work_dir })
      return textResponse(result.ok ? result.text : `Error: ${result.error}`, !result.ok)
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
    return textResponse(JSON.stringify(combined, null, 2))
  },
)

server.tool(
  'kimi_tasks',
  'Manage background work: status, output, or cancel.',
  {
    action: z.enum(['status', 'output', 'cancel']).describe("Action: 'status', 'output', or 'cancel'."),
    task_id: z.string().optional().describe('Omit for status to list all tasks. Required for output.'),
    session_id: z.string().optional().describe('Cancel an ACP session instead of a task (action=cancel).'),
  },
  async ({ action, task_id, session_id }) => {
    if (action === 'status') {
      if (task_id) {
        const task = taskStore.get(task_id)
        return textResponse(task ? JSON.stringify(task, null, 2) : `Task not found: ${task_id}`, !task)
      }
      return textResponse(JSON.stringify(taskStore.list(), null, 2))
    }

    if (action === 'output') {
      if (!task_id) return textResponse('task_id is required for action=output.', true)
      const task = taskStore.get(task_id)
      return textResponse(
        task
          ? JSON.stringify({ id: task.id, status: task.status, output: task.output, outputChunks: task.outputChunks, error: task.error }, null, 2)
          : `Task not found: ${task_id}`,
        !task,
      )
    }

    if (task_id && session_id) {
      return textResponse('Provide either task_id or session_id, not both.', true)
    }
    if (task_id) {
      const task = await taskStore.cancel(task_id)
      return textResponse(task ? JSON.stringify(task, null, 2) : `Task not found: ${task_id}`, !task)
    }
    if (session_id) {
      const result = await cancelAcpSession(session_id)
      return textResponse(JSON.stringify(result, null, 2), !result.ok)
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
  async ({ detail, doctor_target, doctor_path }) => {
    const status = await getKimiStatus()
    const lines = [
      '## Kimi CLI Status',
      `- Installed: ${status.installed ? 'Yes' : 'No'}`,
      `- Binary: ${status.binPath ? `\`${status.binPath}\`` : 'Not found'}`,
      `- Version: ${status.version ?? '(unable to detect)'}`,
      `- Authenticated: ${status.authenticated ? 'Yes' : 'No'}`,
      `- Catalog Found: ${status.catalogFound ? 'Yes' : 'No'}`,
      `- Catalog: \`${status.catalogPath}\``,
      `- Credentials Found: ${status.credentialsFound ? 'Yes' : 'No'}`,
      `- Config Found: ${status.configFound ? 'Yes' : 'No'}`,
      '',
      '## Kimi Code API',
      `- Configured: ${isApiConfigured() ? 'Yes' : 'No'}`,
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
    return textResponse(JSON.stringify(result, null, 2))
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
    async ({ output_path, session_id, include_global_log, overwrite_existing }) => {
      const result = await exportKimiSession({
        outputPath: output_path,
        sessionId: session_id,
        includeGlobalLog: include_global_log ?? false,
        overwriteExisting: overwrite_existing ?? false,
      })
      return textResponse(JSON.stringify(result, null, 2), !result.ok)
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
    async ({ session_id, host, port, launch }) => {
      try {
        return textResponse(JSON.stringify(visualizeSession({ sessionId: session_id, host, port, launch }), null, 2))
      } catch (error) {
        return textResponse(`Error: ${error instanceof Error ? error.message : String(error)}`, true)
      }
    },
  )

  server.tool(
    'kimi_desktop_status',
    'Experimental read-only Kimi Desktop Work status probe. Does not read token stores or replay web auth.',
    {},
    async () => textResponse(JSON.stringify(await getDesktopStatus(), null, 2)),
  )

  server.tool(
    'kimi_budget_probe',
    'Experimental guided budget-separation evidence workflow. Does not submit desktop Work tasks.',
    {
      include_cli_probe_note: z.boolean().optional(),
    },
    async ({ include_cli_probe_note }) => textResponse(buildBudgetProbeGuide(include_cli_probe_note ?? false)),
  )
}

export { server }

const isMain = process.argv[1] === fileURLToPath(import.meta.url)
if (isMain) {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
