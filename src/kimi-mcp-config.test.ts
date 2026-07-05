import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { generateMcpConfig } from './kimi-mcp-config.js'

describe('kimi mcp config generator', () => {
  it('defaults the server name to ladder-mcp', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-mcp-config-'))
    const result = generateMcpConfig({ projectDir: root })
    const servers = (result.config as { mcpServers: Record<string, unknown> }).mcpServers
    expect(Object.keys(servers)).toEqual(['ladder-mcp'])
  })

  it('previews a project mcp config without writing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-mcp-config-'))
    const result = generateMcpConfig({ projectDir: root, serverName: 'ladder_test' })
    expect(result.wrote).toBe(false)
    expect(result.path).toBe(path.join(root, '.kimi-code', 'mcp.json'))
    expect(JSON.stringify(result.config)).toContain('ladder_test')
    expect(fs.existsSync(result.path)).toBe(false)
  })

  it('merges only selected server entry when writing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-mcp-config-'))
    const configPath = path.join(root, '.kimi-code', 'mcp.json')
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { existing: { command: 'x' } } }))

    const result = generateMcpConfig({
      projectDir: root,
      serverName: 'ladder_test',
      write: true,
      command: process.execPath,
      args: ['dist/index.js'],
    })
    const written = JSON.parse(fs.readFileSync(result.path, 'utf-8')) as { mcpServers: Record<string, unknown> }
    expect(written.mcpServers.existing).toEqual({ command: 'x' })
    expect(written.mcpServers.ladder_test).toEqual({ command: process.execPath, args: ['dist/index.js'], env: {} })
  })

  it('does not replace malformed existing config', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-mcp-config-'))
    const configPath = path.join(root, '.kimi-code', 'mcp.json')
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, '{not json')

    expect(() => generateMcpConfig({ projectDir: root, write: true })).toThrow(/not valid JSON/)
    expect(fs.readFileSync(configPath, 'utf-8')).toBe('{not json')
  })

  it('refuses to write under kimi-code-mcp reference tree', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-mcp-config-'))
    const referenceRoot = path.join(root, 'kimi-code-mcp')
    expect(() => generateMcpConfig({ projectDir: referenceRoot, write: true })).toThrow(/kimi-code-mcp/)
  })

  it('refuses to overwrite malformed mcpServers array', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-mcp-config-'))
    const configPath = path.join(root, '.kimi-code', 'mcp.json')
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: [{ command: 'x' }] }))

    expect(() => generateMcpConfig({ projectDir: root, serverName: 'ladder_test', write: true })).toThrow(/mcpServers/)
  })

  it('rejects server names with control characters', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-mcp-config-'))
    expect(() => generateMcpConfig({ projectDir: root, serverName: 'bad\nname' })).toThrow(/server_name/)
  })

  it('rejects an arbitrary non-whitelisted command', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-mcp-config-'))
    expect(() => generateMcpConfig({ projectDir: root, command: 'powershell' })).toThrow(/command must be/)
  })

  it('rejects an absolute path to a non-existent file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-mcp-config-'))
    expect(() => generateMcpConfig({ projectDir: root, command: path.join(root, 'does-not-exist.exe') })).toThrow(/command must be/)
  })

  it('accepts process.execPath and an absolute path to an existing file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-mcp-config-'))
    const dummyBinary = path.join(root, 'dummy-server.js')
    fs.writeFileSync(dummyBinary, '// shim')
    expect(() => generateMcpConfig({ projectDir: root, command: process.execPath })).not.toThrow()
    expect(() => generateMcpConfig({ projectDir: root, command: dummyBinary })).not.toThrow()
  })

  it('rejects bare node and npx as PATH-relative spoofs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-mcp-config-'))
    expect(() => generateMcpConfig({ projectDir: root, command: 'node' })).toThrow(/command must be/)
    expect(() => generateMcpConfig({ projectDir: root, command: 'npx' })).toThrow(/command must be/)
  })
})
