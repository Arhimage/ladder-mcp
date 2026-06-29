import { loadApiAuth } from './environment.js'
import { truncateAtBoundary } from './response.js'
import { clampTimeout } from './transports/acp.js'
import type { KimiResult } from './types.js'

const KIMI_USER_AGENT = 'KimiCLI/1.0'
const DEFAULT_MODEL = 'kimi-for-coding'
const API_DEFAULT_TIMEOUT_MS = 300_000

export interface KimiApiConfig {
  prompt: string
  system?: string
  model?: string
  timeoutMs?: number
  maxOutputChars?: number
}

export function isApiConfigured(): boolean {
  return loadApiAuth() !== null
}

export async function runKimiApi(config: KimiApiConfig): Promise<KimiResult> {
  const auth = loadApiAuth()
  if (!auth) {
    return {
      ok: false,
      text: '',
      error: 'Kimi Code API key not found. Set KIMI_API_KEY (legacy KIMICODE_API_KEY also accepted) or add api_key to ~/.kimi-code/config.toml. Note: kimi_code works without this key; it is only needed for kimi_ask.',
    }
  }

  const controller = new AbortController()
  // Clamp to a positive finite value; a zero/NaN/negative timeout would abort
  // instantly and fail the request before the network round-trip.
  const timeoutMs = clampTimeout(config.timeoutMs, API_DEFAULT_TIMEOUT_MS)
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const maxOutputChars = config.maxOutputChars ?? 60_000
  const maxTokens = Math.ceil(maxOutputChars / 4) + 4000
  const messages: Array<{ role: string; content: string }> = []
  if (config.system) messages.push({ role: 'system', content: config.system })
  messages.push({ role: 'user', content: config.prompt })

  try {
    const response = await fetch(`${auth.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${auth.apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': KIMI_USER_AGENT,
      },
      body: JSON.stringify({
        model: config.model ?? DEFAULT_MODEL,
        messages,
        temperature: 1,
        max_tokens: maxTokens,
      }),
    })

    const bodyText = await response.text()
    if (!response.ok) {
      let message = bodyText.slice(0, 400)
      try {
        const parsed = JSON.parse(bodyText) as { error?: { message?: string } }
        message = parsed.error?.message ?? message
      } catch {
        // Keep raw body slice.
      }
      return { ok: false, text: '', error: `Kimi API HTTP ${response.status}: ${message}` }
    }

    const data = JSON.parse(bodyText) as {
      choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>
    }
    const message = data.choices?.[0]?.message
    const text = message?.content?.trim() ?? ''
    const thinking = message?.reasoning_content

    if (!text) {
      return { ok: false, text: '', thinking, error: 'Kimi API returned an empty answer.' }
    }

    return { ok: true, text: truncateAtBoundary(text, maxOutputChars), thinking }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { ok: false, text: '', error: `Kimi API timed out after ${Math.round(timeoutMs / 1000)}s` }
    }
    return { ok: false, text: '', error: `Kimi API network error: ${error instanceof Error ? error.message : String(error)}` }
  } finally {
    clearTimeout(timer)
  }
}
