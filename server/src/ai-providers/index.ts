// server/src/ai-providers/index.ts

import type { AIProvider } from './types'
import { OpenAIProvider } from './openai'

export type AIProviderType = 'openai' | 'anthropic'

export function getAIProvider(
  providerType: AIProviderType,
  apiKey: string
): AIProvider {
  switch (providerType) {
    case 'openai':
      return new OpenAIProvider(apiKey)
    case 'anthropic':
      throw new Error('Anthropic provider not yet implemented')
    default:
      throw new Error(`Unknown AI provider: ${providerType}`)
  }
}

export * from './types'
export { OpenAIProvider } from './openai'
export {
  RateLimitError,
  InvalidAPIKeyError,
  AIProviderError,
  AIResponseParseError,
} from './openai'
