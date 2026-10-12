/** Configuration contracts. Kept free of `vscode` imports so the AI layer is testable in plain Node. */

export type ProviderId = 'openai' | 'anthropic';

export const PROVIDER_IDS: readonly ProviderId[] = ['openai', 'anthropic'];

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};

export interface AISettings {
  /** Master switch: when false, no code is ever sent anywhere. */
  enabled: boolean;
  provider: ProviderId;
  models: Record<ProviderId, string>;
  autoExplain: boolean;
  /** Upper bound of source characters included in one request. */
  maxContextChars: number;
}

export interface SettingsSource {
  read(): AISettings;
}

/** Where API keys live. The VS Code implementation is backed by SecretStorage. */
export interface ApiKeyStore {
  get(provider: ProviderId): Promise<string | undefined>;
  set(provider: ProviderId, key: string): Promise<void>;
  delete(provider: ProviderId): Promise<void>;
}
