import * as vscode from 'vscode';
import type { ExplanationService } from '../ai/ExplanationService';
import type { ConfigurationService } from '../config/ConfigurationService';
import { PROVIDER_IDS, PROVIDER_LABELS, type ApiKeyStore, type ProviderId } from '../config/types';

const MODEL_SUGGESTIONS: Record<ProviderId, string[]> = {
  openai: ['gpt-5', 'gpt-5-mini', 'gpt-4.1', 'gpt-4o-mini'],
  anthropic: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
};

/** Commands that configure AI. None of them ever echoes or logs the API key. */
export class AiCommands {
  constructor(
    private readonly config: ConfigurationService,
    private readonly keys: ApiKeyStore,
    private readonly explanation: ExplanationService,
  ) {}

  async selectProvider(): Promise<void> {
    const current = this.config.read().provider;
    const items = await Promise.all(
      PROVIDER_IDS.map(async (id) => ({
        label: PROVIDER_LABELS[id],
        description: [id === current ? 'current' : '', (await this.keys.get(id)) ? 'API key stored' : 'no API key'].filter(Boolean).join(' · '),
        id,
      })),
    );
    const picked = await vscode.window.showQuickPick(items, { title: 'Code Flow: AI provider', placeHolder: 'Which provider explains the code?' });
    if (!picked) return;
    await this.config.setProvider(picked.id);
    if (!(await this.keys.get(picked.id))) {
      const choice = await vscode.window.showInformationMessage(`${picked.label} selected. Add its API key to enable explanations.`, 'Configure API Key');
      if (choice) await this.configureApiKey();
    }
  }

  async configureApiKey(): Promise<void> {
    const provider = this.config.read().provider;
    const label = PROVIDER_LABELS[provider];
    const value = await vscode.window.showInputBox({
      title: `Code Flow: ${label} API key`,
      prompt: `Stored in VS Code's secret storage (OS keychain) for ${label}. Leave empty and press Enter to cancel.`,
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (/\s/.test(v.trim()) ? 'API keys do not contain spaces' : undefined),
    });
    const key = value?.trim();
    if (!key) return;
    await this.keys.set(provider, key);
    void vscode.window.showInformationMessage(`Code Flow: ${label} API key saved securely. Use "Test AI Connection" to verify it.`);
  }

  async clearApiKey(): Promise<void> {
    const provider = this.config.read().provider;
    const label = PROVIDER_LABELS[provider];
    if (!(await this.keys.get(provider))) {
      void vscode.window.showInformationMessage(`Code Flow: no ${label} API key is stored.`);
      return;
    }
    await this.keys.delete(provider);
    void vscode.window.showInformationMessage(`Code Flow: ${label} API key removed.`);
  }

  async selectModel(): Promise<void> {
    const { provider, models } = this.config.read();
    const label = PROVIDER_LABELS[provider];
    const custom = '$(edit) Enter a model ID…';
    const picked = await vscode.window.showQuickPick(
      [
        ...MODEL_SUGGESTIONS[provider].map((m) => ({ label: m, description: m === models[provider] ? 'current' : undefined })),
        { label: custom, description: 'any model ID your account can use' },
      ],
      { title: `Code Flow: ${label} model`, placeHolder: `Current: ${models[provider]}` },
    );
    if (!picked) return;
    let model = picked.label;
    if (model === custom) {
      const typed = await vscode.window.showInputBox({
        title: `Code Flow: ${label} model ID`,
        value: models[provider],
        validateInput: (v) => (/^[\w.:/-]+$/.test(v.trim()) ? undefined : 'Enter a model ID such as gpt-5-mini'),
      });
      if (!typed?.trim()) return;
      model = typed.trim();
    }
    await this.config.setModel(provider, model);
    this.explanation.clearCache();
    void vscode.window.showInformationMessage(`Code Flow: ${label} model set to ${model}.`);
  }

  async testConnection(): Promise<void> {
    const settings = this.config.read();
    if (!settings.enabled) {
      void vscode.window.showWarningMessage('Code Flow: AI explanations are disabled. Enable them first.');
      return;
    }
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Code Flow: testing ${PROVIDER_LABELS[settings.provider]}…` },
      () => this.explanation.testConnection(),
    );
    if (result.ok) {
      void vscode.window.showInformationMessage(`Code Flow: connected to ${PROVIDER_LABELS[result.provider]} with model ${result.model}.`);
    } else {
      void vscode.window.showErrorMessage(`Code Flow: AI connection failed. ${result.message}`);
    }
  }

  async toggleAi(): Promise<void> {
    const next = !this.config.read().enabled;
    await this.config.setEnabled(next);
    void vscode.window.showInformationMessage(
      next ? 'Code Flow: AI explanations enabled.' : 'Code Flow: AI explanations disabled. No code will be sent to any provider.',
    );
  }
}
