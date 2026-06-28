import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { PACKAGE_NAME, VERSION } from './version.js'

describe('version', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as {
    name: string
    version: string
  }

  it('exposes the version from package.json (no hardcoded drift)', () => {
    expect(VERSION).toBe(manifest.version)
  })

  it('exposes the package name from package.json', () => {
    expect(PACKAGE_NAME).toBe(manifest.name)
  })

  it('never falls back to the 0.0.0 sentinel when package.json is readable', () => {
    expect(VERSION).not.toBe('0.0.0')
  })
})
