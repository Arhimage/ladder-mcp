import { readFileSync } from 'node:fs'

interface PackageManifest {
  name?: string
  version?: string
}

// Single source of truth for the package version. Both src/version.ts (dev via tsx)
// and dist/version.js (published) sit one level below the package root, so
// `../package.json` resolves correctly in either location. npm always ships
// package.json in the published tarball, so this is available after install.
function readManifest(): PackageManifest {
  try {
    const manifestUrl = new URL('../package.json', import.meta.url)
    return JSON.parse(readFileSync(manifestUrl, 'utf-8')) as PackageManifest
  } catch {
    return {}
  }
}

const manifest = readManifest()

export const PACKAGE_NAME = manifest.name ?? 'ladder-mcp'
export const VERSION = manifest.version ?? '0.0.0'
