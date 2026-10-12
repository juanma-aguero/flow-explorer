import * as vscode from 'vscode';
import type { AISettings, ProviderId, SettingsSource } from './types';

const SECTION = 'codeFlow.ai';

/** Reads and writes the `codeFlow.ai.*` settings. Settings never contain secrets. */
export class ConfigurationService implements SettingsSource {
  read(): AISettings {
    const c = vscode.workspace.getConfiguration(SECTION);
    const provider = c.get<string>('provider') === 'anthropic' ? 'anthropic' : 'openai';
    return {
      enabled: c.get<boolean>('enabled', true),
      provider,
      models: {
        openai: (c.get<string>('openaiModel') ?? '').trim() || 'gpt-5-mini',
        anthropic: (c.get<string>('anthropicModel') ?? '').trim() || 'claude-haiku-5-5',
      },
      autoExplain: c.get<boolean>('autoExplain', false),
      maxContextChars: Math.max(500, c.get<number>('maxContextChars', 6000)),
    };
  }

  setProvider(provider: ProviderId): Thenable<void> {
    return vscode.workspace.getConfiguration(SECTION).update('provider', provider, vscode.ConfigurationTarget.Global);
  }

  setModel(provider: ProviderId, model: string): Thenable<void> {
    const key = provider === 'openai' ? 'openaiModel' : 'anthropicModel';
    return vscode.workspace.getConfiguration(SECTION).update(key, model, vscode.ConfigurationTarget.Global);
  }

  setEnabled(enabled: boolean): Thenable<void> {
    return vscode.workspace.getConfiguration(SECTION).update('enabled', enabled, vscode.ConfigurationTarget.Global);
  }
}
