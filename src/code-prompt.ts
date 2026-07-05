import type { DetailLevel } from './types.js'

export const FORMAT_INSTRUCTIONS: Record<DetailLevel, string> = {
  summary: `
OUTPUT FORMAT CONSTRAINTS:
- Maximum ~2000 words. Be extremely concise.
- Use bullet points, not paragraphs.
- List file paths and one-line descriptions only.
- No code snippets.
- Structure: ## Overview -> ## Key Findings -> ## File Index`,
  normal: `
OUTPUT FORMAT CONSTRAINTS:
- Maximum ~5000 words. Be concise but thorough.
- Use structured sections with markdown headers.
- Include function/class signatures, not full implementations.
- Reference file paths and line numbers when useful.
- Structure: ## Overview -> ## Architecture -> ## Key Findings -> ## File Details`,
  detailed: `
OUTPUT FORMAT CONSTRAINTS:
- Maximum ~15000 words.
- Include relevant snippets only when they materially help.
- Explain dependency relationships and data flow.`,
}

export const AI_CONSUMER_NOTICE = `
IMPORTANT: Your response will be consumed by another AI model with limited context. Prioritize density, concrete file references, and structured markdown.`

export function wrapPrompt(prompt: string, detailLevel: DetailLevel): string {
  return `${prompt}\n${FORMAT_INSTRUCTIONS[detailLevel]}\n${AI_CONSUMER_NOTICE}`
}

export function wrapCodePrompt(prompt: string, detailLevel: DetailLevel, edit: boolean | undefined): string {
  const editGuard = edit
    ? 'EDIT MODE: You may modify files when needed to satisfy the request.'
    : 'READ-ONLY MODE: Do not modify files. Analyze only and report findings.'
  return `${editGuard}\n\n${wrapPrompt(prompt, detailLevel)}`
}
