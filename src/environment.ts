import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface EnvironmentOptions {
  env?: NodeJS.ProcessEnv
  existsSync?: (candidate: string) => boolean
  readFileSync?: (candidate: string, encoding: BufferEncoding) => string
}

export interface KimiPaths {
  homeDir: string
  kimiDir: string
  configPath: string
  credentialsPath: string
  sessionsDir: string
  sessionIndexPath: string
  legacyDir: string
  pathBinary?: string
  defaultBinary: string
  binaryPath?: string
}

export interface ApiAuth {
  apiKey: string
  baseUrl: string
}

export interface KimiStatus {
  installed: boolean
  binPath?: string
  version?: string
  authenticated: boolean
  catalogFound: boolean
  catalogPath: string
  configFound: boolean
  credentialsFound: boolean
  apiConfigured: boolean
  error?: string
}

const DEFAULT_BASE_URL = 'https://api.kimi.com/coding/v1'

function getEnv(options?: EnvironmentOptions): NodeJS.ProcessEnv {
  return options?.env ?? process.env
}

function exists(candidate: string, options?: EnvironmentOptions): boolean {
  return options?.existsSync ? options.existsSync(candidate) : fs.existsSync(candidate)
}

function readText(candidate: string, options?: EnvironmentOptions): string {
  return (options?.readFileSync ?? fs.readFileSync)(candidate, 'utf-8')
}

export function getWindowsHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.USERPROFILE) return env.USERPROFILE
  if (env.HOMEDRIVE && env.HOMEPATH) return `${env.HOMEDRIVE}${env.HOMEPATH}`
  throw new Error('USERPROFILE is not set; Ladder_mcp v1 supports Windows only.')
}

function splitWindowsPath(pathValue: string | undefined): string[] {
  return (pathValue ?? '').split(';').map((part) => part.trim()).filter(Boolean)
}

export function findKimiOnPath(env: NodeJS.ProcessEnv = process.env, existsSync: (candidate: string) => boolean = fs.existsSync): string | undefined {
  for (const entry of splitWindowsPath(env.PATH ?? env.Path)) {
    const exe = path.join(entry, 'kimi.exe')
    if (existsSync(exe)) return exe
  }
  return undefined
}

export function resolveKimiPaths(options?: EnvironmentOptions): KimiPaths {
  const env = getEnv(options)
  const homeDir = getWindowsHome(env)
  const kimiDir = path.join(homeDir, '.kimi-code')
  const defaultBinary = path.join(kimiDir, 'bin', 'kimi.exe')
  const pathBinary = findKimiOnPath(env, (candidate) => exists(candidate, options))
  const binaryPath = pathBinary ?? (exists(defaultBinary, options) ? defaultBinary : undefined)

  return {
    homeDir,
    kimiDir,
    configPath: path.join(kimiDir, 'config.toml'),
    credentialsPath: path.join(kimiDir, 'credentials', 'kimi-code.json'),
    sessionsDir: path.join(kimiDir, 'sessions'),
    sessionIndexPath: path.join(kimiDir, 'session_index.jsonl'),
    legacyDir: path.join(homeDir, '.kimi'),
    pathBinary,
    defaultBinary,
    binaryPath,
  }
}

export function interpolateEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{(\w+)\}/g, (_, name: string) => env[name] ?? '')
}

function readTomlString(raw: string, key: string): string | undefined {
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']*)["']`, 'm')
  return raw.match(pattern)?.[1]
}

export function loadApiAuth(options?: EnvironmentOptions): ApiAuth | null {
  const env = getEnv(options)
  const paths = resolveKimiPaths(options)
  // KIMI_API_KEY is the real kimi-code variable; KIMICODE_API_KEY is a legacy
  // name invented by this wrapper and kept for backward compatibility.
  let apiKey = env.KIMI_API_KEY ?? env.KIMICODE_API_KEY ?? ''
  let baseUrl = env.KIMI_BASE_URL ?? ''

  if ((!apiKey || !baseUrl) && exists(paths.configPath, options)) {
    try {
      const raw = readText(paths.configPath, options)
      if (!apiKey) apiKey = readTomlString(raw, 'api_key') ?? ''
      if (!baseUrl) baseUrl = readTomlString(raw, 'base_url') ?? ''

      if (!apiKey || !baseUrl) {
        const providers = parseProviderBlocks(raw)
        const coding = providers.find((provider) => provider.baseUrl?.includes('/coding'))
        const chosen = coding ?? providers.find((provider) => provider.apiKey) ?? providers[0]
        if (chosen) {
          if (!apiKey && chosen.apiKey) apiKey = chosen.apiKey
          if (!baseUrl && chosen.baseUrl) baseUrl = chosen.baseUrl
        }
      }
    } catch {
      // Environment variables are sufficient; malformed config simply means no file-based auth.
    }
  }

  apiKey = interpolateEnv(apiKey, env).trim()
  baseUrl = interpolateEnv(baseUrl || DEFAULT_BASE_URL, env).trim().replace(/\/$/, '')
  return apiKey ? { apiKey, baseUrl } : null
}

function parseProviderBlocks(raw: string): Array<{ apiKey?: string; baseUrl?: string }> {
  const providers: Array<{ apiKey?: string; baseUrl?: string }> = []
  let current: { apiKey?: string; baseUrl?: string } | null = null

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const section = trimmed.match(/^\[(.+?)]$/)
    if (section) {
      current = section[1].startsWith('providers.') ? {} : null
      if (current) providers.push(current)
      continue
    }

    if (!current) continue
    const kv = trimmed.match(/^(\w+)\s*=\s*["']([^"']*)["']/)
    if (!kv) continue
    if (kv[1] === 'api_key') current.apiKey = kv[2]
    if (kv[1] === 'base_url') current.baseUrl = kv[2]
  }

  return providers
}

export function isAuthenticated(options?: EnvironmentOptions): boolean {
  const paths = resolveKimiPaths(options)
  if (!exists(paths.credentialsPath, options)) return false

  try {
    const raw = readText(paths.credentialsPath, options)
    const data = JSON.parse(raw) as Record<string, unknown>
    return Boolean(data.access_token || data.refresh_token || data.id_token || data.token)
  } catch {
    // A corrupt or unreadable credentials file is NOT proof of authentication.
    // Returning true here produced a false-positive "authenticated" status that
    // misled diagnostics (NFR-5). Fail closed.
    return false
  }
}

export function isKimiInstalled(options?: EnvironmentOptions): boolean {
  return Boolean(resolveKimiPaths(options).binaryPath)
}

export async function getKimiVersion(binaryPath: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(binaryPath, ['--version'], {
      env: buildKimiEnv(env),
      timeout: 5000,
      windowsHide: true,
    })
    return String(stdout).trim() || undefined
  } catch {
    return undefined
  }
}

export function buildKimiEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const paths = resolveKimiPaths({ env })
  const currentPath = env.PATH ?? env.Path ?? ''
  const binDir = path.dirname(paths.defaultBinary)
  const pathName = env.PATH !== undefined ? 'PATH' : 'Path'
  const nextEnv = { ...env }
  const entries = splitWindowsPath(currentPath)
  if (!entries.some((entry) => path.normalize(entry).toLowerCase() === path.normalize(binDir).toLowerCase())) {
    nextEnv[pathName] = `${binDir}${currentPath ? `;${currentPath}` : ''}`
  }
  return nextEnv
}

export async function getKimiStatus(options?: EnvironmentOptions): Promise<KimiStatus> {
  const paths = resolveKimiPaths(options)
  const catalogFound = exists(paths.kimiDir, options)
  const credentialsFound = exists(paths.credentialsPath, options)
  const configFound = exists(paths.configPath, options)
  const apiConfigured = loadApiAuth(options) !== null
  const installed = Boolean(paths.binaryPath)
  const authenticated = isAuthenticated(options)

  let error: string | undefined
  if (!catalogFound) {
    error = exists(paths.legacyDir, options)
      ? 'Found legacy ~/.kimi but not ~/.kimi-code. Update Kimi CLI to the current kimi-code version.'
      : 'Kimi catalog ~/.kimi-code was not found. Install or update Kimi Code CLI.'
  } else if (!installed) {
    error = 'Kimi CLI binary was not found on PATH or at ~/.kimi-code/bin/kimi.exe.'
  } else if (!authenticated) {
    error = 'Kimi CLI is not authenticated. Run: kimi login'
  }

  const version = paths.binaryPath ? await getKimiVersion(paths.binaryPath, getEnv(options)) : undefined
  return {
    installed,
    binPath: paths.binaryPath ?? paths.defaultBinary,
    version,
    authenticated,
    catalogFound,
    catalogPath: paths.kimiDir,
    configFound,
    credentialsFound,
    apiConfigured,
    error,
  }
}
