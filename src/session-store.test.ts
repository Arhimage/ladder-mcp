import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { listSessions } from './session-store.js'

describe('session-store', () => {
  it('reads v24 session_index.jsonl and filters by workDir', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-sessions-'))
    const sessionDir = path.join(root, 'sessions', 'wd_repo_abcd', 'session_abc')
    fs.mkdirSync(sessionDir, { recursive: true })
    fs.writeFileSync(path.join(root, 'session_index.jsonl'), [
      JSON.stringify({ sessionId: 'session_abc', sessionDir, workDir: 'C:/repo', title: 'Repo scan' }),
      JSON.stringify({ sessionId: 'session_def', sessionDir: path.join(root, 'missing'), workDir: 'C:/other' }),
    ].join('\n'))

    const sessions = listSessions({ kimiDir: root, workDir: 'C:/repo' })
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({ id: 'session_abc', title: 'Repo scan', workDir: 'C:/repo' })
  })

  it('recovers real workDir from disk session state.json when available', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-sessions-'))
    const sessionDir = path.join(root, 'sessions', 'wd_real_abcd', 'session_real')
    fs.mkdirSync(sessionDir, { recursive: true })
    fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({ cwd: 'C:/real-project', title: 'Real project scan' }))

    const sessions = listSessions({ kimiDir: root })
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({ id: 'session_real', title: 'Real project scan', workDir: 'C:/real-project' })
  })
})
