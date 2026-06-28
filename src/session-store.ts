import * as fs from 'node:fs'
import * as path from 'node:path'
import { resolveKimiPaths } from './environment.js'
import type { KimiSession } from './types.js'

interface SessionIndexRecord {
  sessionId?: string
  id?: string
  sessionDir?: string
  workDir?: string
  title?: string
  updatedAt?: string
  createdAt?: string
}

export interface ListSessionsOptions {
  workDir?: string
  limit?: number
  kimiDir?: string
}

function normalizeForCompare(candidate: string): string {
  return path.resolve(candidate).replace(/\\/g, '/').toLowerCase()
}

function statTime(candidate: string | undefined): string | undefined {
  if (!candidate) return undefined
  try {
    return fs.statSync(candidate).mtime.toISOString()
  } catch {
    return undefined
  }
}

function readSessionState(sessionDir: string | undefined): Record<string, unknown> | undefined {
  if (!sessionDir) return undefined
  const statePath = path.join(sessionDir, 'state.json')
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf-8')) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function readSessionTitle(sessionDir: string | undefined): string | undefined {
  const data = readSessionState(sessionDir)
  if (!data) return undefined
  for (const key of ['title', 'name', 'summary']) {
    const value = data[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function readSessionWorkDir(sessionDir: string | undefined): string | undefined {
  const data = readSessionState(sessionDir)
  if (!data) return undefined
  for (const key of ['cwd', 'workDir', 'work_dir', 'workingDirectory']) {
    const value = data[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function toSession(record: SessionIndexRecord): KimiSession | undefined {
  const id = record.sessionId ?? record.id
  const workDir = record.workDir
  if (!id || !workDir) return undefined

  const lastModified = record.updatedAt ?? record.createdAt ?? statTime(record.sessionDir) ?? new Date(0).toISOString()
  return {
    id,
    title: record.title?.trim() || readSessionTitle(record.sessionDir) || '(untitled)',
    workDir,
    sessionDir: record.sessionDir,
    lastModified,
  }
}

function readIndexSessions(kimiDir: string): KimiSession[] {
  const indexPath = path.join(kimiDir, 'session_index.jsonl')
  let raw: string
  try {
    raw = fs.readFileSync(indexPath, 'utf-8')
  } catch {
    return []
  }

  const sessions: KimiSession[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const session = toSession(JSON.parse(line) as SessionIndexRecord)
      if (session) sessions.push(session)
    } catch {
      // Skip corrupt lines without failing the whole listing.
    }
  }
  return sessions
}

function readDirectorySessions(kimiDir: string): KimiSession[] {
  const sessionsRoot = path.join(kimiDir, 'sessions')
  let workDirs: string[]
  try {
    workDirs = fs.readdirSync(sessionsRoot)
  } catch {
    return []
  }

  const sessions: KimiSession[] = []
  for (const workDirName of workDirs) {
    if (!workDirName.startsWith('wd_')) continue
    const workDirPath = path.join(sessionsRoot, workDirName)
    let sessionDirs: string[]
    try {
      sessionDirs = fs.readdirSync(workDirPath)
    } catch {
      continue
    }

    for (const sessionDirName of sessionDirs) {
      if (!sessionDirName.startsWith('session_')) continue
      const sessionDir = path.join(workDirPath, sessionDirName)
      sessions.push({
        id: sessionDirName,
        title: readSessionTitle(sessionDir) || '(untitled)',
        workDir: readSessionWorkDir(sessionDir) ?? `(unknown: ${workDirName})`,
        sessionDir,
        lastModified: statTime(sessionDir) ?? new Date(0).toISOString(),
      })
    }
  }
  return sessions
}

export function listSessions(options: ListSessionsOptions = {}): KimiSession[] {
  const limit = options.limit ?? 20
  const kimiDir = options.kimiDir ?? resolveKimiPaths().kimiDir
  const byId = new Map<string, KimiSession>()

  for (const session of [...readDirectorySessions(kimiDir), ...readIndexSessions(kimiDir)]) {
    if (options.workDir && normalizeForCompare(session.workDir) !== normalizeForCompare(options.workDir)) continue
    const existing = byId.get(session.id)
    if (!existing || existing.workDir.startsWith('(unknown:')) byId.set(session.id, session)
  }

  return [...byId.values()]
    .sort((a, b) => b.lastModified.localeCompare(a.lastModified))
    .slice(0, limit)
}
