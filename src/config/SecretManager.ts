import type * as vscode from 'vscode';
import type { ApiKeyStore, ProviderId } from './types';

/** API keys live only in VS Code SecretStorage (OS keychain); never in settings, files or logs. */
export class SecretManager implements ApiKeyStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  get(provider: ProviderId): Promise<string | undefined> {
    return Promise.resolve(this.secrets.get(this.keyFor(provider)));
  }

  set(provider: ProviderId, key: string): Promise<void> {
    return Promise.resolve(this.secrets.store(this.keyFor(provider), key));
  }

  delete(provider: ProviderId): Promise<void> {
    return Promise.resolve(this.secrets.delete(this.keyFor(provider)));
  }

  private keyFor(provider: ProviderId): string {
    return `codeFlow.apiKey.${provider}`;
  }
}
