import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

export interface ToolUseRequest {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResult {
  ok: boolean
  output?: string
  error?: string
}

export const MAX_READ_BYTES = 8 * 1024 * 1024
const MAX_DIR_ENTRIES = 500
const MAX_SEARCH_RESULTS = 500
const MAX_TOOL_OUTPUT_CHARS = 80_000
const ALLOWED_TOOLS = ['list_directory', 'read_text_file', 'search_text', 'write_text_file', 'apply_text_patch']

export function getMinimaxTools(edit: boolean): unknown[] {
  const tools: unknown[] = [
    {
      name: 'list_directory',
      description: 'List the files and directories inside a given path relative to work_dir.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path relative to work_dir.' },
        },
        required: ['path'],
      },
    },
    {
      name: 'read_text_file',
      description: 'Read the contents of a text file inside work_dir. Returns an error for files larger than 8 MiB.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to work_dir.' },
        },
        required: ['path'],
      },
    },
    {
      name: 'search_text',
      description: 'Search for a query string inside a text file inside work_dir. Returns matching lines with line numbers.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to work_dir.' },
          query: { type: 'string', description: 'Text or RegExp pattern to search for.' },
        },
        required: ['path', 'query'],
      },
    },
  ]

  if (edit) {
    tools.push(
      {
        name: 'write_text_file',
        description: 'Create or overwrite a text file inside work_dir.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path relative to work_dir.' },
            content: { type: 'string', description: 'Full file content to write.' },
          },
          required: ['path', 'content'],
        },
      },
      {
        name: 'apply_text_patch',
        description: 'Apply a list of replacements to a text file inside work_dir. Each oldText must occur exactly once.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path relative to work_dir.' },
            replacements: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  oldText: { type: 'string', description: 'Exact text to replace.' },
                  newText: { type: 'string', description: 'Replacement text.' },
                },
                required: ['oldText', 'newText'],
              },
            },
          },
          required: ['path', 'replacements'],
        },
      },
    )
  }

  return tools
}

export async function executeMinimaxTool(
  options: { workDir: string; edit: boolean; tool: ToolUseRequest; maxReadBytes?: number },
  deps: {
    readFile?: (filePath: string) => Promise<Buffer>
    writeFile?: (filePath: string, content: string) => Promise<void>
    mkdir?: (dirPath: string) => Promise<void>
    rename?: (oldPath: string, newPath: string) => Promise<void>
    unlink?: (filePath: string) => Promise<void>
    readdir?: (dirPath: string) => Promise<unknown[]>
    stat?: (filePath: string) => Promise<{ isDirectory: () => boolean; isFile: () => boolean; size: number }>
  } = {},
): Promise<ToolResult> {
  const { workDir, edit, tool } = options
  if (!ALLOWED_TOOLS.includes(tool.name)) {
    return { ok: false, error: `Tool '${tool.name}' is not allowed.` }
  }

  if ((tool.name === 'write_text_file' || tool.name === 'apply_text_patch') && !edit) {
    return { ok: false, error: `Tool '${tool.name}' requires edit=true.` }
  }

  switch (tool.name) {
    case 'list_directory':
      return listDirectory(workDir, tool.input, deps)
    case 'read_text_file':
      return readTextFile(workDir, tool.input, options.maxReadBytes ?? MAX_READ_BYTES, deps)
    case 'search_text':
      return searchText(workDir, tool.input, deps)
    case 'write_text_file':
      return writeTextFile(workDir, tool.input, deps)
    case 'apply_text_patch':
      return applyTextPatch(workDir, tool.input, deps)
    default:
      return { ok: false, error: `Tool '${tool.name}' is not implemented.` }
  }
}

function resolveSafePath(
  workDir: string,
  rawPath: unknown,
): { ok: true; filePath: string } | { ok: false; error: string } {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    return { ok: false, error: 'Path must be a non-empty string.' }
  }
  // Reject drive-relative paths like C:file or C:dir\file.
  if (/^[A-Za-z]:[^\\/]/.test(rawPath)) {
    return { ok: false, error: `Drive-relative paths are not allowed: ${rawPath}` }
  }

  const resolved = path.resolve(workDir, rawPath)
  const relative = path.relative(workDir, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ok: false, error: `Path escapes work_dir: ${rawPath}` }
  }

  const workNormalized = path.normalize(workDir).toLowerCase()
  const resolvedNormalized = path.normalize(resolved).toLowerCase()
  const prefix = workNormalized.endsWith(path.sep) ? workNormalized : `${workNormalized}${path.sep}`
  if (resolvedNormalized !== workNormalized && !resolvedNormalized.startsWith(prefix)) {
    return { ok: false, error: `Path escapes work_dir: ${rawPath}` }
  }

  return { ok: true, filePath: resolved }
}

function boundOutput(text: string, maxChars = MAX_TOOL_OUTPUT_CHARS): string {
  if (text.length <= maxChars) return text
  const notice = `\n\n---\nOutput truncated (${text.length.toLocaleString()} chars exceeded ${maxChars.toLocaleString()} char tool limit).`
  return `${text.slice(0, Math.max(0, maxChars - notice.length))}${notice}`
}

async function listDirectory(
  workDir: string,
  input: Record<string, unknown>,
  deps: {
    readdir?: (dirPath: string) => Promise<unknown[]>
    stat?: (filePath: string) => Promise<{ isDirectory: () => boolean; isFile: () => boolean; size: number }>
  } = {},
): Promise<ToolResult> {
  const safe = resolveSafePath(workDir, input.path)
  if (!safe.ok) return safe

  const readdir = deps.readdir ?? ((dirPath: string) => fs.readdir(dirPath, { withFileTypes: true }))
  const stat = deps.stat ?? ((filePath: string) => fs.stat(filePath))

  let entries: unknown[]
  try {
    entries = await readdir(safe.filePath)
  } catch (error) {
    return { ok: false, error: `Could not list directory: ${error instanceof Error ? error.message : String(error)}` }
  }

  let targetStat
  try {
    targetStat = await stat(safe.filePath)
  } catch {
    return { ok: false, error: `Path does not exist: ${String(input.path)}` }
  }
  if (!targetStat.isDirectory()) {
    return { ok: false, error: `Path is not a directory: ${String(input.path)}` }
  }

  const names = entries
    .map((entry) => {
      if (entry && typeof entry === 'object' && 'name' in entry) {
        const name = String((entry as { name: unknown }).name)
        const isDir = (entry as { isDirectory?: () => boolean }).isDirectory?.() ?? false
        return isDir ? `[DIR]  ${name}` : `[FILE] ${name}`
      }
      return String(entry)
    })
    .sort((a, b) => a.localeCompare(b))

  let output = names.join('\n')
  if (names.length > MAX_DIR_ENTRIES) {
    output = `${names.slice(0, MAX_DIR_ENTRIES).join('\n')}\n\n---\nDirectory listing truncated (${names.length} entries; showing first ${MAX_DIR_ENTRIES}).`
  }

  return { ok: true, output: boundOutput(output) }
}

async function readTextFile(
  workDir: string,
  input: Record<string, unknown>,
  maxBytes: number,
  deps: {
    readFile?: (filePath: string) => Promise<Buffer>
    stat?: (filePath: string) => Promise<{ isDirectory: () => boolean; isFile: () => boolean; size: number }>
  } = {},
): Promise<ToolResult> {
  const safe = resolveSafePath(workDir, input.path)
  if (!safe.ok) return safe

  const stat = deps.stat ?? ((filePath: string) => fs.stat(filePath))
  const readFile = deps.readFile ?? ((filePath: string) => fs.readFile(filePath))

  let fileStat
  try {
    fileStat = await stat(safe.filePath)
  } catch (error) {
    return { ok: false, error: `File not found: ${String(input.path)}` }
  }
  if (fileStat.isDirectory()) {
    return { ok: false, error: `Path is a directory: ${String(input.path)}` }
  }
  if (fileStat.size > maxBytes) {
    try {
      const handle = await fs.open(safe.filePath, 'r')
      const buffer = Buffer.alloc(maxBytes)
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
      await handle.close()
      const head = buffer.toString('utf-8', 0, bytesRead)
      return {
        ok: false,
        error: `File exceeds ${maxBytes.toLocaleString()} byte read limit (${fileStat.size.toLocaleString()} bytes). First ${maxBytes.toLocaleString()} bytes shown.\n\n${head}`,
      }
    } catch (error) {
      return { ok: false, error: `File exceeds read limit and could not be read: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  let content: Buffer
  try {
    content = await readFile(safe.filePath)
  } catch (error) {
    return { ok: false, error: `Could not read file: ${error instanceof Error ? error.message : String(error)}` }
  }

  return { ok: true, output: boundOutput(content.toString('utf-8')) }
}

async function searchText(
  workDir: string,
  input: Record<string, unknown>,
  deps: {
    readFile?: (filePath: string) => Promise<Buffer>
    stat?: (filePath: string) => Promise<{ isDirectory: () => boolean; isFile: () => boolean; size: number }>
  } = {},
): Promise<ToolResult> {
  const safe = resolveSafePath(workDir, input.path)
  if (!safe.ok) return safe
  if (typeof input.query !== 'string' || input.query.length === 0) {
    return { ok: false, error: 'search_text requires a non-empty query.' }
  }

  const result = await readTextFile(workDir, { path: input.path }, MAX_READ_BYTES, deps)
  if (!result.ok) return result

  let pattern: RegExp
  try {
    pattern = new RegExp(input.query, 'i')
  } catch {
    pattern = new RegExp(input.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  }

  const lines = (result.output ?? '').split('\n')
  const matches: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) {
      matches.push(`${(i + 1).toString().padStart(5, ' ')}: ${lines[i]}`)
      if (matches.length >= MAX_SEARCH_RESULTS) break
    }
  }

  if (matches.length === 0) {
    return { ok: true, output: `No matches for '${input.query}' in ${String(input.path)}.` }
  }

  let output = matches.join('\n')
  if (matches.length >= MAX_SEARCH_RESULTS) {
    output = `${output}\n\n---\nSearch results truncated (first ${MAX_SEARCH_RESULTS} matches).`
  }
  return { ok: true, output: boundOutput(output) }
}

async function writeTextFile(
  workDir: string,
  input: Record<string, unknown>,
  deps: {
    writeFile?: (filePath: string, content: string) => Promise<void>
    mkdir?: (dirPath: string) => Promise<void>
    rename?: (oldPath: string, newPath: string) => Promise<void>
    unlink?: (filePath: string) => Promise<void>
  } = {},
): Promise<ToolResult> {
  const safe = resolveSafePath(workDir, input.path)
  if (!safe.ok) return safe
  if (typeof input.content !== 'string') {
    return { ok: false, error: 'write_text_file requires a string content.' }
  }

  return atomicWrite(safe.filePath, input.content, deps)
}

async function applyTextPatch(
  workDir: string,
  input: Record<string, unknown>,
  deps: {
    readFile?: (filePath: string) => Promise<Buffer>
    writeFile?: (filePath: string, content: string) => Promise<void>
    mkdir?: (dirPath: string) => Promise<void>
    rename?: (oldPath: string, newPath: string) => Promise<void>
    unlink?: (filePath: string) => Promise<void>
  } = {},
): Promise<ToolResult> {
  const safe = resolveSafePath(workDir, input.path)
  if (!safe.ok) return safe

  if (!Array.isArray(input.replacements)) {
    return { ok: false, error: 'apply_text_patch requires a replacements array.' }
  }

  const readFile = deps.readFile ?? ((filePath: string) => fs.readFile(filePath))
  let original: string
  try {
    original = (await readFile(safe.filePath)).toString('utf-8')
  } catch (error) {
    return { ok: false, error: `Could not read file: ${error instanceof Error ? error.message : String(error)}` }
  }

  const replacements = input.replacements as Array<unknown>
  const parsed: Array<{ oldText: string; newText: string }> = []
  for (const item of replacements) {
    if (typeof item !== 'object' || item === null) {
      return { ok: false, error: 'Replacement entry must be an object.' }
    }
    const record = item as Record<string, unknown>
    if (typeof record.oldText !== 'string' || typeof record.newText !== 'string') {
      return { ok: false, error: 'Each replacement must have oldText and newText strings.' }
    }
    parsed.push({ oldText: record.oldText, newText: record.newText })
  }

  // Verify every oldText occurs exactly once in the original file.
  for (const { oldText } of parsed) {
    const count = original.split(oldText).length - 1
    if (count === 0) {
      return { ok: false, error: `oldText not found in file: ${oldText.slice(0, 100)}` }
    }
    if (count > 1) {
      return { ok: false, error: `oldText occurs ${count} times (must be exactly once): ${oldText.slice(0, 100)}` }
    }
  }

  let updated = original
  for (const { oldText, newText } of parsed) {
    updated = updated.replace(oldText, newText)
  }

  return atomicWrite(safe.filePath, updated, deps)
}

async function atomicWrite(
  filePath: string,
  content: string,
  deps: {
    writeFile?: (filePath: string, content: string) => Promise<void>
    mkdir?: (dirPath: string) => Promise<void>
    rename?: (oldPath: string, newPath: string) => Promise<void>
    unlink?: (filePath: string) => Promise<void>
  } = {},
): Promise<ToolResult> {
  const writeFile = deps.writeFile ?? ((fp: string, c: string) => fs.writeFile(fp, c, 'utf-8'))
  const mkdir = deps.mkdir ?? ((dp: string) => fs.mkdir(dp, { recursive: true }) as Promise<void>)
  const rename = deps.rename ?? ((oldPath: string, newPath: string) => fs.rename(oldPath, newPath))
  const unlink = deps.unlink ?? ((fp: string) => fs.unlink(fp))

  const parentDir = path.dirname(filePath)
  const tempPath = path.join(parentDir, `.tmp-${crypto.randomUUID()}`)
  try {
    await mkdir(parentDir)
    await writeFile(tempPath, content)
    await rename(tempPath, filePath)
    return { ok: true, output: `Wrote ${filePath}` }
  } catch (error) {
    try {
      await unlink(tempPath)
    } catch {
      // ignore cleanup failure
    }
    return { ok: false, error: `Write failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}
