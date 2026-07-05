import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { wrapCodePrompt } from '../code-prompt.js'
import type { DetailLevel, KimiResult, ProgressReporter } from '../types.js'
import { findMmxOnPath, parseMmxChatResponse, runMmxCommand, type MmxEnvironment } from './minimax.js'
import {
  acquireMinimaxSessionLock,
  createMinimaxSession,
  loadMinimaxSession,
  saveMinimaxSession,
  type MinimaxContentBlock,
  type MinimaxMessage,
  type MinimaxSession,
} from './minimax-session.js'
import { executeMinimaxTool, getMinimaxTools, type ToolUseRequest } from './minimax-tools.js'

const DEFAULT_MMX_CODE_TIMEOUT_MS = 120_000
const MAX_ITERATIONS = 20

export interface MinimaxCodeOptions {
  prompt: string
  workDir: string
  sessionId?: string
  edit?: boolean
  detailLevel?: DetailLevel
  includeThinking?: boolean
  timeoutMs?: number
  env?: MmxEnvironment
  existsSync?: (candidate: string) => boolean
  signal?: AbortSignal
  onProgress?: ProgressReporter
}

export interface MinimaxCodeDeps {
  findMmxOnPath?: typeof findMmxOnPath
  runMmxCommand?: typeof runMmxCommand
  executeMinimaxTool?: typeof executeMinimaxTool
  createMinimaxSession?: typeof createMinimaxSession
  loadMinimaxSession?: typeof loadMinimaxSession
  saveMinimaxSession?: typeof saveMinimaxSession
  acquireMinimaxSessionLock?: typeof acquireMinimaxSessionLock
  tmpdir?: () => string
  writeFile?: (path: string, content: string) => Promise<void>
  unlink?: (path: string) => Promise<void>
}

function reportProgress(onProgress: ProgressReporter | undefined, text: string, metadata?: Record<string, unknown>) {
  onProgress?.({
    kind: 'status',
    text,
    at: new Date().toISOString(),
    metadata,
  })
}

function buildCodePrompt(prompt: string, detailLevel?: DetailLevel, edit?: boolean): string {
  return wrapCodePrompt(prompt, detailLevel ?? 'normal', edit)
}

export async function runMinimaxCode(
  options: MinimaxCodeOptions,
  deps: MinimaxCodeDeps = {},
): Promise<KimiResult> {
  const locateBinary = deps.findMmxOnPath ?? findMmxOnPath
  const runCommand = deps.runMmxCommand ?? runMmxCommand
  const runTool = deps.executeMinimaxTool ?? executeMinimaxTool
  const createSession = deps.createMinimaxSession ?? createMinimaxSession
  const loadSession = deps.loadMinimaxSession ?? loadMinimaxSession
  const saveSession = deps.saveMinimaxSession ?? saveMinimaxSession
  const acquireLock = deps.acquireMinimaxSessionLock ?? acquireMinimaxSessionLock
  const tmpdir = deps.tmpdir ?? os.tmpdir
  const writeFile = deps.writeFile ?? ((fp, content) => fs.writeFile(fp, content, 'utf-8'))
  const unlink = deps.unlink ?? ((fp) => fs.unlink(fp))

  if (options.signal?.aborted) {
    return { ok: false, text: '', error: 'MiniMax code run was aborted.' }
  }

  const binaryPath = locateBinary(options.env, options.existsSync)
  if (!binaryPath) {
    return {
      ok: false,
      text: '',
      error: 'MiniMax CLI (mmx) was not found on PATH. Install mmx and ensure it is on PATH.',
    }
  }

  let session: MinimaxSession
  if (options.sessionId) {
    const loaded = await loadSession(options.sessionId, { workDir: options.workDir })
    if (!loaded.ok) {
      return { ok: false, text: '', error: loaded.error }
    }
    session = loaded.session
  } else {
    session = await createSession(options.workDir)
  }

  const releaseLock = acquireLock(session.id)
  if (!releaseLock) {
    return { ok: false, text: '', error: `MiniMax session is already locked: ${session.id}` }
  }

  const timeoutMs =
    typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_MMX_CODE_TIMEOUT_MS
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000))
  const tools = getMinimaxTools(options.edit === true)

  try {
    const wrappedPrompt = buildCodePrompt(options.prompt, options.detailLevel, options.edit)
    const userMessage: MinimaxMessage = { role: 'user', content: wrappedPrompt }
    session.messages.push(userMessage)

    for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
      if (options.signal?.aborted) {
        return { ok: false, text: '', error: 'MiniMax code run was aborted.', sessionId: session.id }
      }

      reportProgress(options.onProgress, `MiniMax iteration ${iteration}`, { iteration, sessionId: session.id })

      const messagesFile = path.join(tmpdir(), `ladder-mcp-minimax-${session.id}-${iteration}.json`)
      let rawResponse: string
      try {
        await writeFile(messagesFile, JSON.stringify(session.messages, null, 2))
        const args = [
          'text',
          'chat',
          '--messages-file',
          messagesFile,
          ...tools.flatMap((tool) => ['--tool', JSON.stringify(tool)]),
          '--output',
          'json',
          '--non-interactive',
          '--no-color',
          '--timeout',
          String(timeoutSeconds),
        ]
        const { stdout } = await runCommand(binaryPath, args, {
          env: options.env,
          timeout: timeoutMs + 10_000,
          existsSync: options.existsSync,
          signal: options.signal,
        })
        rawResponse = stdout
      } finally {
        try {
          await unlink(messagesFile)
        } catch {
          // ignore cleanup failure
        }
      }

      const parsed = parseMmxChatResponse(rawResponse)
      if (!parsed.ok) {
        return { ok: false, text: '', error: parsed.error ?? 'MiniMax response could not be parsed.', sessionId: session.id }
      }

      const contentBlocks: MinimaxContentBlock[] = []
      if (parsed.text) {
        contentBlocks.push({ type: 'text', text: parsed.text })
      }
      if (parsed.thinking) {
        contentBlocks.push({ type: 'thinking', thinking: parsed.thinking })
      }
      const toolUses = parsed.toolUses ?? []
      for (const toolUse of toolUses) {
        contentBlocks.push({
          type: 'tool_use',
          id: toolUse.id,
          name: toolUse.name,
          input: toolUse.input as Record<string, unknown>,
        })
      }

      session.messages.push({ role: 'assistant', content: contentBlocks })
      await saveSession(session)

      if (toolUses.length === 0) {
        if (!parsed.text) {
          return {
            ok: false,
            text: '',
            error: 'MiniMax returned an empty answer.',
            sessionId: session.id,
          }
        }
        return {
          ok: true,
          text: parsed.text,
          thinking: parsed.thinking,
          sessionId: session.id,
          metadata: { iterations: iteration, provider: 'minimax' },
        }
      }

      const toolResults: MinimaxContentBlock[] = []
      for (const toolUse of toolUses) {
        const tool: ToolUseRequest = { id: toolUse.id, name: toolUse.name, input: toolUse.input as Record<string, unknown> }
        const result = await runTool({ workDir: options.workDir, edit: options.edit === true, tool })
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: result.ok ? (result.output ?? '') : `Error: ${result.error ?? 'Tool failed.'}`,
        })
      }
      session.messages.push({ role: 'user', content: toolResults })
      await saveSession(session)
    }

    return {
      ok: false,
      text: '',
      error: `MiniMax reached the maximum ${MAX_ITERATIONS} iterations without producing a final answer.`,
      sessionId: session.id,
      resumable: true,
      metadata: { iterations: MAX_ITERATIONS, provider: 'minimax' },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/timed out/i.test(message)) {
      return {
        ok: false,
        text: '',
        error: `MiniMax code run timed out after ${Math.round(timeoutMs / 1000)}s`,
        sessionId: session.id,
        resumable: true,
      }
    }
    return { ok: false, text: '', error: `MiniMax code run failed: ${message}`, sessionId: session.id }
  } finally {
    releaseLock()
  }
}
