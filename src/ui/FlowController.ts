import * as vscode from 'vscode';
import type { ExplanationService } from '../ai/ExplanationService';
import type { ConfigurationService } from '../config/ConfigurationService';
import { PROVIDER_LABELS, type ProviderId } from '../config/types';
import type { EditorNavigator } from '../editor/EditorNavigator';
import type { HighlightManager } from '../editor/HighlightManager';
import type { FlowEngine, StartMode } from '../flow/FlowEngine';
import type { NavigationResult } from '../flow/FlowTypes';
import type { ExplanationView, FlowSidebarProvider } from './FlowSidebarProvider';

const SUPPORTED_LANGUAGES = new Set(['typescript', 'typescriptreact', 'javascript', 'javascriptreact', 'go']);

export const normalizeFsPath = (p: string): string => p.replace(/\\/g, '/');

/**
 * Glue between the flow engine and everything the user sees: editor reveal, highlights, sidebar,
 * context keys and AI explanations. Holds no analysis logic.
 */
export class FlowController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private renderSeq = 0;
  private explanations = new Map<string, ExplanationView>();
  private inflight: AbortController | undefined;
  private lastStepKey: string | undefined;

  constructor(
    private readonly engine: FlowEngine,
    private readonly editor: EditorNavigator,
    private readonly highlights: HighlightManager,
    private readonly sidebar: FlowSidebarProvider,
    private readonly explanation: ExplanationService,
    private readonly config: ConfigurationService,
    private readonly state: vscode.Memento,
  ) {
    this.disposables.push(engine.onDidChange(() => void this.render()));
  }

  // -- starting --------------------------------------------------------------

  async start(mode: StartMode): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !SUPPORTED_LANGUAGES.has(editor.document.languageId)) {
      void vscode.window.showInformationMessage('Code Flow: open a TypeScript, JavaScript or Go file and place the cursor inside a function.');
      return;
    }
    if (editor.document.uri.scheme !== 'file') {
      void vscode.window.showInformationMessage('Code Flow: only files on disk can be explored (save the file first).');
      return;
    }
    const file = normalizeFsPath(editor.document.uri.fsPath);
    const offset = editor.document.offsetAt(editor.selection.active);

    const hadSession = this.engine.isActive;
    const result = await this.engine.startAt(file, offset, mode);
    if (!result.ok) {
      void vscode.window.showWarningMessage(`Code Flow: ${result.message}`);
      return;
    }
    if (!hadSession && !this.sidebar.isVisible) {
      await vscode.commands.executeCommand('workbench.view.extension.codeFlow');
    }
    await this.maybeAutoExplain();
  }

  // -- navigation ------------------------------------------------------------

  async run(action: () => Promise<NavigationResult>): Promise<void> {
    if (!this.engine.isActive) {
      void vscode.window.showInformationMessage('Code Flow: no active exploration. Use "Code Flow: Explore from Here" first.');
      return;
    }
    const result = await action();
    if (!result.moved && result.message) {
      void vscode.window.showInformationMessage(`Code Flow: ${result.message}`);
    } else if (result.moved && result.message) {
      vscode.window.setStatusBarMessage(`Code Flow: ${result.message}`, 5000);
    }
    if (result.moved) await this.maybeAutoExplain();
  }

  stop(): void {
    this.engine.stop();
  }

  // -- AI --------------------------------------------------------------------

  async explainCurrentStep(options: { auto?: boolean } = {}): Promise<void> {
    const ctx = await this.engine.stepContext();
    const snapshot = await this.engine.snapshot();
    if (!ctx || !snapshot) return;
    const key = snapshot.step.id;

    const status = await this.explanation.status();
    if (status.state === 'disabled') {
      this.setExplanation(key, { state: 'notice', text: 'AI explanations are disabled (setting codeFlow.ai.enabled).' });
      return;
    }
    if (status.state === 'missing-key') {
      this.setExplanation(key, {
        state: 'notice',
        text: `No ${PROVIDER_LABELS[status.provider]} API key configured. Run "Code Flow: Configure API Key" to enable explanations.`,
      });
      if (!options.auto) {
        const choice = await vscode.window.showInformationMessage(
          `Code Flow: add your ${PROVIDER_LABELS[status.provider]} API key to get AI explanations. Navigation works without it.`,
          'Configure API Key',
        );
        if (choice) await vscode.commands.executeCommand('codeFlow.configureApiKey');
      }
      return;
    }
    if (!(await this.hasConsent(status.provider, options.auto === true))) return;

    this.inflight?.abort();
    const controller = new AbortController();
    this.inflight = controller;
    this.setExplanation(key, { state: 'loading' });

    const outcome = await this.explanation.explain(ctx, controller.signal);
    if (this.inflight === controller) this.inflight = undefined;

    switch (outcome.status) {
      case 'ok':
        this.setExplanation(key, { state: 'ok', text: outcome.text, provider: PROVIDER_LABELS[outcome.provider], model: outcome.model });
        break;
      case 'cancelled':
        break;
      case 'error':
        this.setExplanation(key, { state: 'notice', text: `Could not get an explanation: ${outcome.message}` });
        break;
      case 'disabled':
        this.setExplanation(key, { state: 'notice', text: 'AI explanations are disabled.' });
        break;
      case 'missing-key':
        this.setExplanation(key, { state: 'notice', text: 'No API key configured.' });
        break;
    }
  }

  /** Re-renders the panel (e.g. after settings or secrets changed). */
  refreshPanel(): void {
    void this.render({ reveal: false });
  }

  private async maybeAutoExplain(): Promise<void> {
    if (!this.config.read().autoExplain) return;
    await this.explainCurrentStep({ auto: true });
  }

  /** Explicit, remembered consent per provider before any code leaves the machine. */
  private async hasConsent(provider: ProviderId, silent: boolean): Promise<boolean> {
    const key = `codeFlow.consent.${provider}`;
    if (this.state.get<boolean>(key)) return true;
    if (silent) return false;
    const label = PROVIDER_LABELS[provider];
    const choice = await vscode.window.showWarningMessage(
      `Code Flow will send the current step and its enclosing function (at most ${this.config.read().maxContextChars} characters of your source) to ${label} to generate explanations. No other files are sent.`,
      { modal: true, detail: 'You can turn this off any time with "Code Flow: Enable/Disable AI Explanations". Navigation never requires AI.' },
      'Allow',
    );
    if (choice !== 'Allow') return false;
    await this.state.update(key, true);
    return true;
  }

  private setExplanation(stepKey: string, view: ExplanationView): void {
    this.explanations.set(stepKey, view);
    void this.render({ reveal: false });
  }

  // -- rendering -------------------------------------------------------------

  private async render(options: { reveal?: boolean } = {}): Promise<void> {
    const seq = ++this.renderSeq;
    const snapshot = await this.engine.snapshot();
    void vscode.commands.executeCommand('setContext', 'codeFlow.active', snapshot !== undefined);

    if (!snapshot) {
      this.inflight?.abort();
      this.explanations.clear();
      this.lastStepKey = undefined;
      this.highlights.update(undefined);
      this.sidebar.update({ flow: undefined, ai: await this.aiInfo(), explanation: { state: 'none' } });
      return;
    }

    // Moving to another step abandons any pending request for the previous one.
    if (snapshot.step.id !== this.lastStepKey) {
      this.inflight?.abort();
      this.lastStepKey = snapshot.step.id;
    }

    if (options.reveal !== false && !snapshot.stale) {
      await this.editor.reveal(snapshot.step.range);
      if (seq !== this.renderSeq) return; // a newer render superseded this one
    }
    this.highlights.update(snapshot);
    this.sidebar.update({
      flow: snapshot,
      ai: await this.aiInfo(),
      explanation: this.explanations.get(snapshot.step.id) ?? { state: 'none' },
    });
  }

  private async aiInfo(): Promise<{ state: 'disabled' | 'missing-key' | 'ready'; label?: string }> {
    const status = await this.explanation.status();
    if (status.state === 'disabled') return { state: 'disabled' };
    return { state: status.state, label: `${PROVIDER_LABELS[status.provider]} · ${status.model}` };
  }

  dispose(): void {
    this.inflight?.abort();
    for (const d of this.disposables) d.dispose();
  }
}
