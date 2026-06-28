import { describe, expect, it } from 'vitest'
import * as path from 'node:path'
import { findKimiOnPath, getWindowsHome, isAuthenticated, loadApiAuth, resolveKimiPaths } from './environment.js'

describe('environment', () => {
  it('uses USERPROFILE as Windows home', () => {
    expect(getWindowsHome({ USERPROFILE: 'C:\\Users\\shers' })).toBe('C:\\Users\\shers')
  })

  it('finds kimi.exe from Windows PATH split by semicolon', () => {
    const hit = 'C:\\Users\\shers\\.kimi-code\\bin\\kimi.exe'
    const found = findKimiOnPath(
      { PATH: 'C:\\Windows\\System32;C:\\Users\\shers\\.kimi-code\\bin' },
      (candidate) => candidate === hit,
    )
    expect(found).toBe(hit)
  })

  it('falls back to ~/.kimi-code/bin/kimi.exe without legacy catalog fallback', () => {
    const home = 'C:\\Users\\shers'
    const expected = path.join(home, '.kimi-code', 'bin', 'kimi.exe')
    const paths = resolveKimiPaths({
      env: { USERPROFILE: home, PATH: '' },
      existsSync: (candidate) => candidate === expected,
    })
    expect(paths.binaryPath).toBe(expected)
    expect(paths.kimiDir).toBe(path.join(home, '.kimi-code'))
    expect(paths.legacyDir).toBe(path.join(home, '.kimi'))
  })

  it('loads API auth from ~/.kimi-code/config.toml', () => {
    const home = 'C:\\Users\\shers'
    const configPath = path.join(home, '.kimi-code', 'config.toml')
    const auth = loadApiAuth({
      env: { USERPROFILE: home, PATH: '', KIMICODE_API_KEY: 'from-env' },
      existsSync: (candidate) => candidate === configPath,
      readFileSync: () => '[providers.kimi]\napi_key = "${KIMICODE_API_KEY}"\nbase_url = "https://api.kimi.com/coding/v1"\n',
    })
    expect(auth).toEqual({ apiKey: 'from-env', baseUrl: 'https://api.kimi.com/coding/v1' })
  })

  const home = 'C:\\Users\\shers'
  const authOptions = (readFileSync: () => string) => ({
    env: { USERPROFILE: home, PATH: '' },
    existsSync: () => true,
    readFileSync,
  })

  it('reports authenticated for a valid token file', () => {
    expect(isAuthenticated(authOptions(() => JSON.stringify({ access_token: 'x' })))).toBe(true)
  })

  it('fails closed when the credentials file is corrupt JSON', () => {
    expect(isAuthenticated(authOptions(() => '{ not valid json'))).toBe(false)
  })

  it('fails closed when the credentials file cannot be read', () => {
    expect(isAuthenticated(authOptions(() => { throw new Error('EACCES') }))).toBe(false)
  })

  it('reports not authenticated when the credentials file is missing', () => {
    expect(isAuthenticated({ env: { USERPROFILE: home, PATH: '' }, existsSync: () => false })).toBe(false)
  })
})
