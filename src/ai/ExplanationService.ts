import type { ApiKeyStore, ProviderId, SettingsSource } from '../config/types';
import type { StepContext } from '../flow/FlowTypes';
import type { ProviderFactory } from './AIProvider';
import { buildPrompt } from './prompt';

export type ExplainOutcome =
  | { status: 'ok'; text: string; provider: ProviderId; model: string; fromCache: boolean; sourceChars: number }
  | { status: 'disabled' }
  | { status: 'missing-key'; provider: ProviderId }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

export type AiStatus =
  | { state: 'disabled' }
  | { state: 'missing-key'; provider: ProviderId; model: string }
  | { state: 'ready'; provider: ProviderId; model: string };

const CACHE_LIMIT = 100;

/**
 * Produces explanations for a step. Navigation never depends on this class: every failure mode
 * (disabled, no key, network error) is reported as a value so the UI can keep working.
 */
export class ExplanationService {
  private readonly cache = new Map<string, string>();

  constructor(
    private readonly settings: SettingsSource,
    private readonly keys: ApiKeyStore,
    private readonly providers: ProviderFactory,
  ) {}

  async status(): Promise<AiStatus> {
    const s = this.settings.read();
    if (!s.enabled) return { state: 'disabled' };
    const model = s.models[s.provider];
    const key = await this.keys.get(s.provider);
    return key ? { state: 'ready', provider: s.provider, model } : { state: 'missing-key', provider: s.provider, model };
  }

  async explain(ctx: StepContext, signal?: AbortSignal): Promise<ExplainOutcome> {
    const s = this.settings.read();
    if (!s.enabled) return { status: 'disabled' };

    const key = await this.keys.get(s.provider);
    if (!key) return { status: 'missing-key', provider: s.provider };

    const model = s.models[s.provider];
    const built = buildPrompt(ctx, s.maxContextChars);
    const cacheKey = `${s.provider}|${model}|${built.prompt}`;

    const cached = this.cache.get(cacheKey);
    if (cached) {
      return { status: 'ok', text: cached, provider: s.provider, model, fromCache: true, sourceChars: built.sourceChars };
    }

    try {
      const provider = this.providers.create(s.provider, key, model);
      const text = await provider.generate({ system: built.system, prompt: built.prompt, signal });
      if (signal?.aborted) return { status: 'cancelled' };
      if (!text) return { status: 'error', message: 'The AI provider returned an empty response.' };
      this.remember(cacheKey, text);
      return { status: 'ok', text, provider: s.provider, model, fromCache: false, sourceChars: built.sourceChars };
    } catch (error) {
      if (signal?.aborted) return { status: 'cancelled' };
      return { status: 'error', message: redact(errorMessage(error), key) };
    }
  }

  /** Sends a tiny fixed prompt (no user code) to verify key, model and network. */
  async testConnection(): Promise<{ ok: true; provider: ProviderId; model: string } | { ok: false; message: string }> {
    const s = this.settings.read();
    const model = s.models[s.provider];
    const key = await this.keys.get(s.provider);
    if (!key) return { ok: false, message: `No API key configured for ${s.provider}.` };
    try {
      const provider = this.providers.create(s.provider, key, model);
      await provider.generate({
        system: 'You are a connectivity check.',
        prompt: 'Reply with the single word: ok',
        maxOutputTokens: 200,
      });
      return { ok: true, provider: s.provider, model };
    } catch (error) {
      return { ok: false, message: redact(errorMessage(error), key) };
    }
  }

  clearCache(): void {
    this.cache.clear();
  }

  private remember(key: string, text: string): void {
    if (this.cache.size >= CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, text);
  }
}

/** Removes the API key (and obvious key-shaped tokens) from text that may be shown or logged. */
export function redact(text: string, secret?: string): string {
  let out = secret ? text.split(secret).join('***') : text;
  out = out.replace(/\b(sk-[A-Za-z0-9_-]{8,}|sk-ant-[A-Za-z0-9_-]{8,})\b/g, '***');
  return out;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
