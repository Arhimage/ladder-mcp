import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getWindowsHome } from './environment.js'

export interface GenerateMcpConfigOptions {
  scope?: 'project' | 'user'
  projectDir?: string
  serverName?: string
  write?: boolean
  command?: string
  args?: string[]
}

export interface GeneratedMcpConfig {
  path: string
  serverName: string
  config: unknown
  wrote: boolean
}

function defaultServerCommand(): { command: string; args: string[] } {
  const distIndex = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'index.js')
  // Use the actual Node binary that launched this process instead of a bare `node`
  // name that could be spoofed via PATH. This matches the secure default in
  // src/index.ts resolveDefaultServerCommand.
  return { command: process.execPath, args: [distIndex] }
}

export function resolveMcpConfigPath(options: GenerateMcpConfigOptions = {}): string {
  if (options.scope === 'user') {
    return path.join(getWindowsHome(), '.kimi-code', 'mcp.json')
  }
  const projectDir = options.projectDir ? path.resolve(options.projectDir) : process.cwd()
  return path.join(projectDir, '.kimi-code', 'mcp.json')
}

function readExistingConfig(configPath: string): Record<string, unknown> {
  let raw: string
  try {
    raw = fs.readFileSync(configPath, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {}
    }
    throw new Error(`Existing MCP config could not be read and was not modified: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch (error) {
    throw new Error(`Existing MCP config is not valid JSON and was not modified: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function assertWritableProjectTarget(projectDir: string): void {
  // Resolve what we can; if the target does not exist yet, fall back to an absolute
  // path so containment still works against the nearest existing ancestor.
  const resolved = (() => {
    try {
      return fs.realpathSync(projectDir)
    } catch {
      return path.resolve(projectDir)
    }
  })()

  // Walk up the path and reject if any directory segment is exactly the read-only
  // reference tree name. This is containment-based (basename equality), not a
  // substring match, so names like "my-kimi-code-mcp-project" are not blocked.
  let current = resolved
  while (true) {
    if (path.basename(current).toLowerCase() === 'kimi-code-mcp') {
      throw new Error('Refusing to write MCP config under read-only kimi-code-mcp reference tree.')
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
}

// Constrain the launcher written into mcp.json. Without this, an arbitrary `command`
// (e.g. "powershell") would be persisted and later executed when Kimi loads the
// server config. Reject bare names like `node` or `npx` because they resolve through
// the consumer's PATH and can be spoofed. Only accept the actual Node binary that is
// running this process (process.execPath) or an absolute path to an existing file that
// has been vetted by the caller.
function assertSafeCommand(command: string): void {
  const value = command.trim()
  if (value === process.execPath) return
  if (path.isAbsolute(value) && fs.existsSync(value) && fs.statSync(value).isFile()) return
  throw new Error(
    `command must be process.execPath or an absolute path to an existing file; got "${command}".`,
  )
}

function readMcpServers(existing: Record<string, unknown>): Record<string, unknown> {
  const value = existing.mcpServers
  if (value === undefined || value === null) return {}
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  throw new Error('Existing mcpServers entry is not a valid object and was not modified.')
}

export function generateMcpConfig(options: GenerateMcpConfigOptions = {}): GeneratedMcpConfig {
  const configPath = resolveMcpConfigPath(options)
  // Only enforce the read-only-tree guard when we are actually going to write. A
  // dry-run/preview (`write` falsy) produces no file, so it must not throw merely
  // because the cwd happens to sit under a `kimi-code-mcp` reference tree.
  if (options.write && options.scope !== 'user') {
    assertWritableProjectTarget(options.projectDir ?? process.cwd())
  }
  const serverName = options.serverName?.trim() || 'ladder_mcp'
  if (!/^[a-zA-Z0-9_-]+$/.test(serverName)) {
    throw new Error('server_name must contain only letters, digits, underscores, and hyphens.')
  }
  const defaults = defaultServerCommand()
  const command = options.command ?? defaults.command
  assertSafeCommand(command)
  const serverConfig = {
    command,
    args: options.args ?? defaults.args,
    env: {},
  }
  const existing = readExistingConfig(configPath)
  const mcpServers = {
    ...readMcpServers(existing),
    [serverName]: serverConfig,
  }
  const config = { ...existing, mcpServers }

  if (options.write) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8')
  }

  return { path: configPath, serverName, config, wrote: options.write === true }
}
