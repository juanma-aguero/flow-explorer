import { generateText, type LanguageModel } from 'ai';
import type { ProviderId } from '../config/types';

export interface GenerateRequest {
  system: string;
  prompt: string;
  signal?: AbortSignal;
  maxOutputTokens?: number;
}

/** Narrow text-generation contract the rest of the extension depends on. */
export interface AIProvider {
  readonly id: ProviderId;
  readonly model: string;
  generate(request: GenerateRequest): Promise<string>;
}

export interface ProviderFactory {
  create(id: ProviderId, apiKey: string, model: string): AIProvider;
}

/** Shared implementation over any Vercel AI SDK language model. */
export class LanguageModelProvider implements AIProvider {
  constructor(
    readonly id: ProviderId,
    readonly model: string,
    private readonly languageModel: LanguageModel,
  ) {}

  async generate(request: GenerateRequest): Promise<string> {
    const result = await generateText({
      model: this.languageModel,
      system: request.system,
      prompt: request.prompt,
      abortSignal: request.signal,
      maxOutputTokens: request.maxOutputTokens ?? 1200,
      maxRetries: 1,
    });
    return result.text.trim();
  }
}
