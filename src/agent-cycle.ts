// Iterative coder→reviewer development cycle ("dev cycle") across providers.
// One agent session implements, a second independent session reviews the diff,
// and the loop repeats until the reviewer approves or max_iterations is reached.
import { execFile } from 'node:child_process'
import { runKimiCodeAgent } from './agent-code-kimi.js'
import { runMinimaxCode } from './providers/minimax-code.js'
import type { ProviderId } from './providers/types.js'
import { truncateAtBoundary } from './response.js'
import type { DetailLevel, KimiResult, ProgressReporter } from './types.js'

const MAX_DIFF_CHARS = 50_000
const GIT_TIMEOUT_MS = 30_000

export type CycleVerdict = 'approved' | 'revise' | 'unparsed'

export interface CycleIteration {
  iteration: number
  verdict: CycleVerdict
  reviewNotes?: string
}

export interface AgentCycleOptions {
  prompt: string
  workDir: string
  maxIterations: number
  coderProvider: ProviderId
  reviewerProvider: ProviderId
  edit?: boolean
  detailLevel?: DetailLevel
  timeoutMs?: number
  signal?: AbortSignal
  onProgress?: ProgressReporter
}

export interface AgentCycleResult {
  ok: boolean
  text: string
  error?: string
  finalVerdict: CycleVerdict | 'incomplete'
  iterationsUsed: number
  coderSessionId?: string
  reviewerSessionId?: string
  history: CycleIteration[]
}

export interface CodeRunRequest {
  provider: ProviderId
  prompt: string
  workDir: string
  sessionId?: string
  edit: boolean
  detailLevel: DetailLevel
  timeoutMs?: number
  signal?: AbortSignal
  onProgress?: ProgressReporter
}

export interface AgentCycleDeps {
  runCode?: (request: CodeRunRequest) => Promise<KimiResult>
  getDiff?: (workDir: string, signal?: AbortSignal) => Promise<string | undefined>
}

function defaultRunCode(request: CodeRunRequest): Promise<KimiResult> {
  const options = {
    prompt: request.prompt,
    workDir: request.workDir,
    sessionId: request.sessionId,
    edit: request.edit,
    detailLevel: request.detailLevel,
    includeThinking: false,
    timeoutMs: request.timeoutMs,
    signal: request.signal,
    onProgress: request.onProgress,
  }
  return request.provider === 'minimax' ? runMinimaxCode(options) : runKimiCodeAgent(options)
}

function runGit(args: string[], cwd: string, signal?: AbortSignal): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024, signal },
      (error, stdout) => resolve(error ? undefined : String(stdout ?? '')),
    )
  })
}

// Best-effort snapshot of the coder's changes; undefined when work_dir is not a git repo.
export async function getGitDiff(workDir: string, signal?: AbortSignal): Promise<string | undefined> {
  const status = await runGit(['status', '--porcelain'], workDir, signal)
  if (status === undefined) return undefined
  const diff = (await runGit(['diff', 'HEAD'], workDir, signal)) ?? ''
  const combined = `## git status --porcelain\n${status.trim() || '(clean)'}\n\n## git diff HEAD\n${diff.trim() || '(no diff — changes may be in untracked files listed above)'}`
  return truncateAtBoundary(combined, MAX_DIFF_CHARS)
}

export function parseVerdict(reviewText: string): { verdict: CycleVerdict; notes?: string } {
  const matches = [...reviewText.matchAll(/VERDICT:\s*(APPROVED|REVISE)/gi)]
  if (matches.length === 0) return { verdict: 'unparsed' }
  const last = matches[matches.length - 1]
  const verdict = last[1].toUpperCase() === 'APPROVED' ? 'approved' : 'revise'
  return { verdict, notes: verdict === 'revise' ? reviewText.trim() : undefined }
}

function buildReviewerPrompt(task: string, coderReport: string, diff: string | undefined, iteration: number): string {
  const parts = [
    'You are an independent, skeptical senior code reviewer in an automated coder/reviewer loop. You have read-only repository access: verify the claims below against the actual files.',
    `## Original task\n${task}`,
    `## Coder report (iteration ${iteration})\n${coderReport.trim() || '(coder produced no report)'}`,
  ]
  if (diff) {
    parts.push(`## Changes so far\n${diff}`)
  } else {
    parts.push('## Changes so far\n(work_dir is not a git repository — inspect files directly to verify the work)')
  }
  parts.push(
    'Review for correctness, completeness against the task, and regressions. Be specific and actionable.',
    'Your reply MUST end with exactly one final line: `VERDICT: APPROVED` if the task is fully and correctly done, or `VERDICT: REVISE` preceded by a numbered list of concrete required fixes.',
  )
  return parts.join('\n\n')
}

function buildRevisePrompt(reviewNotes: string): string {
  return `An independent reviewer examined your changes and requires fixes before approval. Address every point below, then summarize what you changed.\n\n## Reviewer feedback\n${reviewNotes}`
}

export async function runAgentCycle(options: AgentCycleOptions, deps: AgentCycleDeps = {}): Promise<AgentCycleResult> {
  const runCode = deps.runCode ?? defaultRunCode
  const getDiff = deps.getDiff ?? getGitDiff
  const detailLevel = options.detailLevel ?? 'normal'
  const edit = options.edit !== false
  const history: CycleIteration[] = []
  let coderSessionId: string | undefined
  let reviewerSessionId: string | undefined
  let coderPrompt = options.prompt
  let lastCoderReport = ''
  let lastReviewText = ''
  let previousUnparsed = false

  const report = (text: string) =>
    options.onProgress?.({ kind: 'status', text, at: new Date().toISOString() })
  const phaseReporter = (phase: string): ProgressReporter | undefined =>
    options.onProgress
      ? (event) => options.onProgress?.({ ...event, text: `[${phase}] ${event.text}` })
      : undefined

  const summary = (finalVerdict: AgentCycleResult['finalVerdict'], closing: string): string => {
    const lines = [
      `# Dev cycle result: ${finalVerdict}`,
      `Iterations used: ${history.length}/${options.maxIterations} (coder=${options.coderProvider}, reviewer=${options.reviewerProvider})`,
      '',
      ...history.map((h) => `- Iteration ${h.iteration}: ${h.verdict}${h.verdict === 'revise' && h.reviewNotes ? ' (see review below)' : ''}`),
      '',
      '## Final coder report',
      lastCoderReport.trim() || '(none)',
      '',
      '## Final review',
      lastReviewText.trim() || '(none)',
      '',
      closing,
    ]
    return lines.join('\n')
  }

  for (let iteration = 1; iteration <= options.maxIterations; iteration++) {
    if (options.signal?.aborted) {
      return {
        ok: false,
        text: summary('incomplete', 'The cycle was cancelled.'),
        error: 'Agent cycle was aborted.',
        finalVerdict: 'incomplete',
        iterationsUsed: history.length,
        coderSessionId,
        reviewerSessionId,
        history,
      }
    }

    report(`Cycle iteration ${iteration}/${options.maxIterations}: coder (${options.coderProvider}) working`)
    const coderResult = await runCode({
      provider: options.coderProvider,
      prompt: coderPrompt,
      workDir: options.workDir,
      sessionId: coderSessionId,
      edit,
      detailLevel,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      onProgress: phaseReporter(`coder ${iteration}/${options.maxIterations}`),
    })
    coderSessionId = coderResult.sessionId ?? coderSessionId
    if (!coderResult.ok) {
      return {
        ok: false,
        text: summary('incomplete', 'The cycle stopped because the coder run failed.'),
        error: `Coder run failed on iteration ${iteration}: ${coderResult.error ?? 'unknown error'}`,
        finalVerdict: 'incomplete',
        iterationsUsed: history.length + 1,
        coderSessionId,
        reviewerSessionId,
        history,
      }
    }
    lastCoderReport = coderResult.text

    const diff = await getDiff(options.workDir, options.signal)

    report(`Cycle iteration ${iteration}/${options.maxIterations}: reviewer (${options.reviewerProvider}) reviewing`)
    const reviewerResult = await runCode({
      provider: options.reviewerProvider,
      prompt: buildReviewerPrompt(options.prompt, coderResult.text, diff, iteration),
      workDir: options.workDir,
      sessionId: reviewerSessionId,
      edit: false,
      detailLevel,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      onProgress: phaseReporter(`reviewer ${iteration}/${options.maxIterations}`),
    })
    reviewerSessionId = reviewerResult.sessionId ?? reviewerSessionId
    if (!reviewerResult.ok) {
      return {
        ok: false,
        text: summary('incomplete', 'The coder work above is done, but the reviewer run failed — review it manually or rerun the cycle.'),
        error: `Reviewer run failed on iteration ${iteration}: ${reviewerResult.error ?? 'unknown error'}`,
        finalVerdict: 'incomplete',
        iterationsUsed: history.length + 1,
        coderSessionId,
        reviewerSessionId,
        history,
      }
    }
    lastReviewText = reviewerResult.text

    const { verdict, notes } = parseVerdict(reviewerResult.text)
    history.push({ iteration, verdict, reviewNotes: notes })
    report(`Cycle iteration ${iteration}/${options.maxIterations}: verdict ${verdict}`)

    if (verdict === 'approved') {
      return {
        ok: true,
        text: summary('approved', 'The reviewer approved the work.'),
        finalVerdict: 'approved',
        iterationsUsed: history.length,
        coderSessionId,
        reviewerSessionId,
        history,
      }
    }

    if (verdict === 'unparsed') {
      if (previousUnparsed) {
        return {
          ok: false,
          text: summary('unparsed', 'Stopped: the reviewer failed to produce a parseable VERDICT line twice in a row. Read the final review above and judge manually.'),
          error: 'Reviewer verdict was unparseable twice in a row.',
          finalVerdict: 'unparsed',
          iterationsUsed: history.length,
          coderSessionId,
          reviewerSessionId,
          history,
        }
      }
      previousUnparsed = true
      coderPrompt = buildRevisePrompt(reviewerResult.text.trim() || '(the reviewer produced no explicit feedback — double-check the task requirements)')
      continue
    }

    previousUnparsed = false
    coderPrompt = buildRevisePrompt(notes ?? reviewerResult.text)
  }

  return {
    ok: true,
    text: summary('revise', `Stopped: max_iterations (${options.maxIterations}) reached without reviewer approval. The last review above lists the outstanding issues; continue with agent_cycle or agent_code using the coder session id.`),
    finalVerdict: 'revise',
    iterationsUsed: history.length,
    coderSessionId,
    reviewerSessionId,
    history,
  }
}
