import { createOpenAI } from '@ai-sdk/openai';
import { LanguageModelProvider } from './AIProvider';

export class OpenAIProvider extends LanguageModelProvider {
  constructor(apiKey: string, model: string) {
    super('openai', model, createOpenAI({ apiKey })(model));
  }
}
