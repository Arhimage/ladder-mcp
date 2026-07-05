import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMinimaxSession, listMinimaxSessions } from './minimax-session.js'

describe('listMinimaxSessions', () => {
  let sessionsDir: string

  beforeEach(async () => {
    sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ladder-mmx-sessions-'))
  })

  afterEach(async () => {
    await fs.rm(sessionsDir, { recursive: true, force: true })
  })

  it('returns an empty list when the directory does not exist', async () => {
    const result = await listMinimaxSessions({ sessionsDir: path.join(sessionsDir, 'missing') })
    expect(result).toEqual([])
  })

  it('lists sessions sorted by updatedAt descending and filters by work_dir', async () => {
    await createMinimaxSession('C:\\repo-a', { sessionsDir, now: () => '2026-01-01T00:00:00.000Z' })
    const newer = await createMinimaxSession('C:\\repo-b', { sessionsDir, now: () => '2026-02-01T00:00:00.000Z' })

    const all = await listMinimaxSessions({ sessionsDir })
    expect(all).toHaveLength(2)
    expect(all[0].id).toBe(newer.id)
    expect(all[0].messageCount).toBe(0)

    const filtered = await listMinimaxSessions({ sessionsDir, workDir: 'C:\\repo-b' })
    expect(filtered).toHaveLength(1)
    expect(filtered[0].workDir).toBe(path.resolve('C:\\repo-b'))
  })

  it('skips corrupt session files and honours limit', async () => {
    await createMinimaxSession('C:\\repo-a', { sessionsDir, now: () => '2026-01-01T00:00:00.000Z' })
    await createMinimaxSession('C:\\repo-a', { sessionsDir, now: () => '2026-01-02T00:00:00.000Z' })
    await fs.writeFile(path.join(sessionsDir, 'minimax_session_broken.json'), 'not json', 'utf-8')

    const result = await listMinimaxSessions({ sessionsDir, limit: 1 })
    expect(result).toHaveLength(1)
    expect(result[0].updatedAt >= '2026-01-02').toBe(true)
  })
})
