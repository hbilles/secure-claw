/**
 * LLM provider factory — creates the appropriate provider
 * based on the secureclaw.yaml configuration.
 */

import type { LLMProvider } from '../llm-provider.js';
import type { SecureClawConfig } from '../config.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';

export function createLLMProvider(config: SecureClawConfig): LLMProvider {
  const { provider } = config.llm;

  switch (provider) {
    case 'anthropic':
      return new AnthropicProvider();

    case 'openai':
      return new OpenAIProvider({
        apiKey: process.env['OPENAI_API_KEY'],
        baseURL: config.llm.baseURL,
      });

    case 'lmstudio':
      return new OpenAIProvider(
        {
          apiKey: 'not-needed',
          baseURL: config.llm.baseURL ?? 'http://host.docker.internal:1234/v1',
        },
        'lmstudio',
      );

    default:
      throw new Error(
        `Unknown LLM provider: "${provider}". ` +
          'Supported providers: anthropic, openai, lmstudio',
      );
  }
}
