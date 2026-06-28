import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_MAX_OUTPUT_CHARS, maxChars, validateWorkDir } from './input-validation.js'

describe('maxChars', () => {
  it('returns the default for undefined', () => {
    expect(maxChars(undefined)).toBe(DEFAULT_MAX_OUTPUT_CHARS)
  })

  it('returns the default for zero', () => {
    expect(maxChars(0)).toBe(DEFAULT_MAX_OUTPUT_CHARS)
  })

  it('returns the default for negative values', () => {
    expect(maxChars(-5)).toBe(DEFAULT_MAX_OUTPUT_CHARS)
  })

  it('returns the default for NaN', () => {
    expect(maxChars(NaN)).toBe(DEFAULT_MAX_OUTPUT_CHARS)
  })

  it('returns the default for Infinity', () => {
    expect(maxChars(Infinity)).toBe(DEFAULT_MAX_OUTPUT_CHARS)
  })

  it('multiplies a valid integer by 4', () => {
    expect(maxChars(1000)).toBe(4000)
  })

  it('floors a non-integer before multiplying', () => {
    expect(maxChars(100.7)).toBe(400)
  })
})

describe('validateWorkDir', () => {
  it('rejects a relative path', () => {
    const error = validateWorkDir('relative/path')
    expect(error).toContain('absolute')
  })

  it('rejects a non-existent absolute path', () => {
    const error = validateWorkDir(path.join(process.cwd(), '__does_not_exist_12345__'))
    expect(error).toContain('does not exist')
  })

  it('accepts an existing absolute directory', () => {
    expect(validateWorkDir(process.cwd())).toBeUndefined()
  })
})
