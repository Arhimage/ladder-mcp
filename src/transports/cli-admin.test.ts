import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildDoctorArgs, buildExportArgs, buildProviderListArgs, buildVisualizeArgs, exportKimiSession, quoteForDisplay } from './cli-admin.js'

describe('cli-admin', () => {
  it('builds doctor args', () => {
    expect(buildDoctorArgs('config')).toEqual(['doctor', 'config'])
    expect(buildDoctorArgs('tui', 'C:/tmp/tui.toml')).toEqual(['doctor', 'tui', 'C:/tmp/tui.toml'])
  })

  it('builds provider list json args', () => {
    expect(buildProviderListArgs()).toEqual(['provider', 'list', '--json'])
  })

  it('always passes -y so the export confirmation prompt cannot stall on EOF', () => {
    expect(buildExportArgs({ sessionId: 'session_1', outputPath: 'C:/tmp/s.zip' })).toEqual([
      'export',
      'session_1',
      '-o',
      'C:/tmp/s.zip',
      '-y',
      '--no-include-global-log',
    ])
  })

  it('keeps -y when overwrite is also requested', () => {
    expect(buildExportArgs({ sessionId: 'session_1', outputPath: 'C:/tmp/s.zip', overwriteExisting: true })).toEqual([
      'export',
      'session_1',
      '-o',
      'C:/tmp/s.zip',
      '-y',
      '--no-include-global-log',
    ])
  })

  it('builds localhost visualizer args with no-open', () => {
    expect(buildVisualizeArgs({ sessionId: 'session_1', port: 6000 })).toEqual([
      'vis',
      'session_1',
      '--host',
      '127.0.0.1',
      '--port',
      '6000',
      '--no-open',
    ])
  })

  it('rejects non-local visualizer hosts', () => {
    expect(() => buildVisualizeArgs({ host: '0.0.0.0' })).toThrow(/localhost/)
  })

  it('rejects invalid visualizer ports', () => {
    expect(() => buildVisualizeArgs({ port: 70000 })).toThrow(/port/)
  })

  it('rejects export paths outside cwd', async () => {
    const result = await exportKimiSession({ outputPath: '../outside.zip' })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/working directory/)
  })

  it('rejects export paths outside an explicit work_dir', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-export-workdir-'))
    const result = await exportKimiSession({ outputPath: '../outside.zip', workDir })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/working directory/)
  })

  it('rejects export paths with null bytes', async () => {
    const result = await exportKimiSession({ outputPath: 'bad\0file.zip' })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/null bytes/)
  })

  it('rejects export paths that are directories', async () => {
    const result = await exportKimiSession({ outputPath: '.' })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/directory/)
  })

  it('quotes display args with shell metacharacters but leaves safe ones bare', () => {
    expect(quoteForDisplay('vis')).toBe('vis')
    expect(quoteForDisplay('C:/tmp/s.zip')).toBe('C:/tmp/s.zip')
    expect(quoteForDisplay('a b')).toBe('"a b"')
    expect(quoteForDisplay('a;rm -rf')).toBe('"a;rm -rf"')
    expect(quoteForDisplay('$(whoami)')).toBe('"$(whoami)"')
  })
})
