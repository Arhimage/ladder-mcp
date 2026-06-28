import * as fs from 'node:fs'
import * as path from 'node:path'

export const DEFAULT_MAX_OUTPUT_CHARS = 60_000

// Convert an untrusted max_output_tokens into a character budget. NaN/Infinity/zero/
// negative/non-integer would otherwise produce a nonsensical budget (e.g. NaN) handed
// to truncation, so clamp those to the default.
export function maxChars(maxOutputTokens: number | undefined): number {
  if (typeof maxOutputTokens !== 'number' || !Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0) {
    return DEFAULT_MAX_OUTPUT_CHARS
  }
  return Math.floor(maxOutputTokens) * 4
}

// Reject a work_dir before spawning Kimi: a relative or non-existent directory would
// otherwise be passed to the CLI as cwd and fail opaquely. Returns an error string when
// invalid, or undefined when the path is an existing absolute directory.
export function validateWorkDir(workDir: string): string | undefined {
  if (!path.isAbsolute(workDir)) return 'work_dir must be an absolute path.'
  let stat: fs.Stats
  try {
    stat = fs.statSync(workDir)
  } catch {
    return `work_dir does not exist: ${workDir}`
  }
  if (!stat.isDirectory()) return `work_dir is not a directory: ${workDir}`
  return undefined
}
