import type { ProviderFactory } from './AIProvider';
import { AnthropicProvider } from './AnthropicProvider';
import { OpenAIProvider } from './OpenAIProvider';

export const defaultProviderFactory: ProviderFactory = {
  create(id, apiKey, model) {
    return id === 'openai' ? new OpenAIProvider(apiKey, model) : new AnthropicProvider(apiKey, model);
  },
};
