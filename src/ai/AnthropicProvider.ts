import { createAnthropic } from '@ai-sdk/anthropic';
import { LanguageModelProvider } from './AIProvider';

export class AnthropicProvider extends LanguageModelProvider {
  constructor(apiKey: string, model: string) {
    super('anthropic', model, createAnthropic({ apiKey })(model));
  }
}
