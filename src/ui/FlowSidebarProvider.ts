import * as vscode from 'vscode';
import type { FlowSnapshot } from '../flow/FlowTypes';
import { renderHtml } from './sidebarHtml';

export type ExplanationView =
  | { state: 'none' }
  | { state: 'loading' }
  | { state: 'ok'; text: string; provider: string; model: string }
  | { state: 'notice'; text: string };

export interface AiPanelInfo {
  state: 'disabled' | 'missing-key' | 'ready';
  /** e.g. "OpenAI · gpt-5-mini" */
  label?: string;
}

/** Everything the webview needs; plain JSON so it can cross the postMessage boundary. */
export interface PanelState {
  flow: FlowSnapshot | undefined;
  ai: AiPanelInfo;
  explanation: ExplanationView;
}

/** Messages the webview may send. Anything else is ignored. */
const ALLOWED_COMMANDS: Record<string, string> = {
  next: 'codeFlow.next',
  previous: 'codeFlow.previous',
  stepInto: 'codeFlow.stepInto',
  stepOut: 'codeFlow.stepOut',
  stop: 'codeFlow.stop',
  explain: 'codeFlow.explainStep',
  explore: 'codeFlow.exploreFromHere',
  selectProvider: 'codeFlow.selectProvider',
  configureApiKey: 'codeFlow.configureApiKey',
  selectModel: 'codeFlow.selectModel',
  testConnection: 'codeFlow.testConnection',
  toggleAi: 'codeFlow.toggleAi',
};

export class FlowSidebarProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'codeFlow.sidebar';

  private view: vscode.WebviewView | undefined;
  private state: PanelState = { flow: undefined, ai: { state: 'missing-key' }, explanation: { state: 'none' } };

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = renderHtml(createNonce(), view.webview.cspSource);
    view.webview.onDidReceiveMessage((message: unknown) => {
      const msg = typeof message === 'object' && message !== null ? (message as { command?: unknown; id?: unknown }) : {};
      const { command, id } = msg;
      if (typeof command !== 'string') return;
      if (Object.prototype.hasOwnProperty.call(ALLOWED_COMMANDS, command)) {
        void vscode.commands.executeCommand(ALLOWED_COMMANDS[command]);
      } else if ((command === 'branch' || command === 'stepIntoCall') && typeof id === 'string' && id.length < 512) {
        // Parameterised actions: clicking a path or a call in the panel.
        void vscode.commands.executeCommand(command === 'branch' ? 'codeFlow.chooseBranch' : 'codeFlow.stepIntoCall', id);
      } else if (command === 'ready') {
        this.post();
      }
    });
    view.onDidDispose(() => {
      this.view = undefined;
    });
    this.post();
  }

  update(state: PanelState): void {
    this.state = state;
    this.post();
  }

  get isVisible(): boolean {
    return this.view?.visible === true;
  }

  private post(): void {
    void this.view?.webview.postMessage({ type: 'state', state: this.state });
  }
}

function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}
