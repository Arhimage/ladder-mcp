import { execFile, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { buildKimiEnv, getKimiStatus, resolveKimiPaths } from '../environment.js'
import { listSessions } from '../session-store.js'

const execFileAsync = promisify(execFile)
const ADMIN_TIMEOUT_MS = 30_000

export interface CommandResult {
  ok: boolean
  stdout: string
  stderr: string
  error?: string
}

export interface CapabilityReport {
  cli: {
    installed: boolean
    binary?: string
    version?: string
    catalogFound: boolean
    authenticated: boolean
  }
  commands: Record<string, boolean>
  acp: { available: boolean; command: string }
  desktop: { experimental: true; readOnly: true }
}

export interface ExportSessionOptions {
  sessionId?: string
  outputPath: string
  workDir?: string
  includeGlobalLog?: boolean
  overwriteExisting?: boolean
}

export interface VisualizeSessionOptions {
  sessionId?: string
  host?: string
  port?: number
  launch?: boolean
}

// Quote a single argument for the human-readable preview command. This string is
// display-only (never executed), but quoting anything outside a conservative safe
// set — not just spaces — keeps the preview copy-paste-safe and unambiguous when an
// argument contains shell metacharacters.
export function quoteForDisplay(arg: string): string {
  return /^[A-Za-z0-9_\-.,:/\\=]+$/.test(arg) ? arg : JSON.stringify(arg)
}

function assertLocalVisualizerAddress(host: string, port: number): void {
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error('kimi_visualize_session only supports localhost hosts.')
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Visualizer port must be an integer from 1 to 65535.')
  }
}

// Canonicalize a path by resolving symlinks in its nearest existing ancestor and
// re-appending the not-yet-existing tail. This lets the containment check below
// compare like-for-like (canonical vs canonical) even when the target file does
// not exist yet, closing the symlink-escape gap.
function canonicalizePath(target: string): string {
  let current = path.resolve(target)
  const tail: string[] = []
  for (;;) {
    try {
      const real = fs.realpathSync(current)
      return tail.length ? path.join(real, ...tail.reverse()) : real
    } catch (error) {
      // Only a missing path (ENOENT) is recoverable: resolve the nearest existing
      // ancestor and re-append the not-yet-created tail. Any other realpath failure
      // (EACCES, ELOOP, …) means we cannot prove containment, so fail closed rather
      // than return a non-canonical path that would defeat the symlink-escape check.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`output_path could not be canonicalized: ${error instanceof Error ? error.message : String(error)}`)
      }
      const parent = path.dirname(current)
      const base = path.basename(current)
      if (parent === current) {
        throw new Error(`output_path could not be canonicalized: path does not exist under a real directory: ${target}`)
      }
      tail.push(base)
      current = parent
    }
  }
}

function assertSafeOutputPath(outputPath: string, workDir?: string): void {
  if (outputPath.includes('\0')) {
    throw new Error('output_path contains invalid null bytes.')
  }
  const base = canonicalizePath(workDir ?? process.cwd())
  const resolved = canonicalizePath(path.isAbsolute(outputPath) ? outputPath : path.resolve(base, outputPath))
  const relative = path.relative(base, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('output_path must be inside the working directory.')
  }
}

function requireBinary(): string {
  const binary = resolveKimiPaths().binaryPath
  if (!binary) throw new Error('Kimi CLI binary was not found on PATH or at ~/.kimi-code/bin/kimi.exe.')
  return binary
}

export function buildDoctorArgs(target: 'config' | 'tui' = 'config', configPath?: string): string[] {
  return ['doctor', target, ...(configPath ? [configPath] : [])]
}

export function buildProviderListArgs(): string[] {
  return ['provider', 'list', '--json']
}

export function buildExportArgs(options: ExportSessionOptions): string[] {
  const args = ['export']
  if (options.sessionId) args.push(options.sessionId)
  args.push('-o', options.outputPath)
  // Always auto-confirm. `kimi export` prompts "Export previous session …? [Y/n]"
  // even for a brand-new path; since we close stdin, that prompt would get EOF and
  // the export would silently no-op while still exiting 0. Overwrite safety is
  // enforced by our own pre-check (assertSafeOutputPath + statSync + overwrite_existing),
  // so unconditionally passing -y is safe.
  args.push('-y')
  if (options.includeGlobalLog !== true) args.push('--no-include-global-log')
  return args
}

export function buildVisualizeArgs(options: VisualizeSessionOptions): string[] {
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 58628
  assertLocalVisualizerAddress(host, port)
  const args = ['vis']
  if (options.sessionId) args.push(options.sessionId)
  args.push('--host', host, '--port', String(port), '--no-open')
  return args
}

const DEFAULT_MAX_BUFFER = 1024 * 1024 * 8
const PROBE_MAX_BUFFER = 1024 * 256

async function runKimiCommand(args: string[], timeoutMs = ADMIN_TIMEOUT_MS, maxBuffer = DEFAULT_MAX_BUFFER): Promise<CommandResult> {
  try {
    const binary = requireBinary()
    const child = execFileAsync(binary, args, {
      env: buildKimiEnv(),
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer,
    })
    // None of these admin commands read stdin. Close it so that if a TOCTOU overwrite
    // prompt (or any other prompt) appears, the CLI receives EOF and fails fast instead
    // of blocking on input until the timeout fires.
    child.child.stdin?.end()
    const { stdout, stderr } = await child
    return { ok: true, stdout: String(stdout), stderr: String(stderr) }
  } catch (error) {
    const err = error as Error & { stdout?: string | Buffer; stderr?: string | Buffer }
    return {
      ok: false,
      stdout: err.stdout ? String(err.stdout) : '',
      stderr: err.stderr ? String(err.stderr) : '',
      error: err.message,
    }
  }
}

export async function getKimiCapabilities(): Promise<CapabilityReport> {
  const status = await getKimiStatus()
  const commandNames = ['acp', 'doctor', 'provider', 'export', 'vis', 'server', 'web']
  const commands: Record<string, boolean> = {}

  if (status.installed) {
    // These seven `--help` probes run in parallel. Cap each one's buffer so the
    // worst-case combined allocation stays small (7 * 256 KiB) instead of 7 * 8 MiB;
    // help text is tiny, so the smaller cap never truncates real output.
    await Promise.all(commandNames.map(async (name) => {
      const result = await runKimiCommand([name, '--help'], 5000, PROBE_MAX_BUFFER)
      commands[name] = result.ok || result.stdout.includes('Usage:') || result.stderr.includes('Usage:')
    }))
  } else {
    for (const name of commandNames) commands[name] = false
  }

  return {
    cli: {
      installed: status.installed,
      binary: status.binPath,
      version: status.version,
      catalogFound: status.catalogFound,
      authenticated: status.authenticated,
    },
    commands,
    acp: { available: commands.acp === true, command: 'kimi acp' },
    desktop: { experimental: true, readOnly: true },
  }
}

export async function runKimiDoctor(target: 'config' | 'tui' = 'config', configPath?: string): Promise<CommandResult> {
  return runKimiCommand(buildDoctorArgs(target, configPath))
}

export async function listKimiProviders(): Promise<unknown> {
  const result = await runKimiCommand(buildProviderListArgs())
  if (!result.ok) return result
  try {
    return JSON.parse(result.stdout)
  } catch {
    return result
  }
}

export async function exportKimiSession(options: ExportSessionOptions): Promise<CommandResult> {
  if (!options.outputPath.trim()) {
    return { ok: false, stdout: '', stderr: '', error: 'output_path is required for kimi_export_session.' }
  }
  try {
    assertSafeOutputPath(options.outputPath, options.workDir)
  } catch (error) {
    return {
      ok: false,
      stdout: '',
      stderr: '',
      error: error instanceof Error ? error.message : String(error),
    }
  }
  // Resolve an explicit session id ourselves when the caller omitted one. `kimi export`
  // otherwise defaults to "the most recent session" and asks "Export previous session …?
  // [Y/n]" — a prompt that `-y` does NOT suppress in Kimi CLI 0.20.1, so with stdin closed
  // it hangs/aborts and writes nothing. Passing an explicit id skips that prompt entirely.
  let sessionId = options.sessionId
  if (!sessionId) {
    const recent = listSessions({ limit: 1 })[0]
    if (!recent) {
      return { ok: false, stdout: '', stderr: '', error: 'No Kimi session found to export. Provide an explicit session_id.' }
    }
    sessionId = recent.id
  }

  const outputPath = path.isAbsolute(options.outputPath)
    ? path.resolve(options.outputPath)
    : path.resolve(options.workDir ?? process.cwd(), options.outputPath)
  let existingStat: fs.Stats | undefined
  try {
    existingStat = fs.statSync(outputPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return {
        ok: false,
        stdout: '',
        stderr: '',
        error: `output_path could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }
  if (existingStat) {
    if (existingStat.isDirectory()) {
      return { ok: false, stdout: '', stderr: '', error: 'output_path must be a file, not a directory.' }
    }
    if (options.overwriteExisting !== true) {
      return {
        ok: false,
        stdout: '',
        stderr: '',
        error: 'output_path already exists. Pass overwrite_existing=true to replace it explicitly.',
      }
    }
  }
  const result = await runKimiCommand(buildExportArgs({ ...options, sessionId, outputPath }), 120_000)
  // The CLI can exit 0 without producing the archive (e.g. a declined/aborted prompt).
  // Verify the file actually exists so we never report success for a no-op export.
  if (result.ok && !fs.existsSync(outputPath)) {
    return {
      ok: false,
      stdout: result.stdout,
      stderr: result.stderr,
      error: 'Kimi export exited without creating the output file. No archive was written.',
    }
  }
  return result
}

export function visualizeSession(options: VisualizeSessionOptions): { command: string; url: string; launched: boolean; pid?: number; error?: string } {
  const binary = requireBinary()
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 58628
  assertLocalVisualizerAddress(host, port)
  const args = buildVisualizeArgs({ ...options, host, port })
  const command = [binary, ...args].map(quoteForDisplay).join(' ')
  const sessionPart = options.sessionId ? `?session=${encodeURIComponent(options.sessionId)}` : ''
  const urlHost = host.includes(':') ? `[${host}]` : host
  const url = `http://${urlHost}:${port}/${sessionPart}`

  if (!options.launch) return { command, url, launched: false }

  const proc = spawn(binary, args, {
    env: buildKimiEnv(),
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
  })
  // Detached fire-and-forget: spawn errors surface asynchronously and cannot be
  // observed before this function returns, so `launched` reflects only whether a
  // pid was assigned. Keep an 'error' listener so an async spawn failure surfaces
  // on our stderr instead of crashing the host as an unhandled 'error' event.
  proc.on('error', (error) => {
    process.stderr.write(`Visualizer process failed to start: ${error instanceof Error ? error.message : String(error)}\n`)
  })
  proc.unref()
  return { command, url, launched: proc.pid !== undefined, pid: proc.pid ?? undefined }
}
