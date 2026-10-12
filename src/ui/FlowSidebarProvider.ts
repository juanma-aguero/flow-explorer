import * as vscode from 'vscode';
import type { FlowSnapshot } from '../flow/FlowTypes';

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
      const id = typeof message === 'object' && message !== null ? (message as { command?: unknown }).command : undefined;
      if (typeof id === 'string' && Object.prototype.hasOwnProperty.call(ALLOWED_COMMANDS, id)) {
        void vscode.commands.executeCommand(ALLOWED_COMMANDS[id]);
      } else if (id === 'ready') {
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

function renderHtml(nonce: string, cspSource: string): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  body { padding: 0 10px 16px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
  h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; opacity: .7; margin: 16px 0 6px; font-weight: 600; }
  .row { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0; }
  button { flex: 1 1 45%; padding: 4px 8px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 1px solid transparent; cursor: pointer; border-radius: 2px; }
  button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button.secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
  button:disabled { opacity: .45; cursor: default; }
  button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  .kv { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; }
  .kv dt { opacity: .7; } .kv dd { margin: 0; word-break: break-word; }
  pre { margin: 4px 0; padding: 6px 8px; background: var(--vscode-textCodeBlock-background); border-left: 3px solid var(--vscode-editorWarning-foreground, #cca700); white-space: pre-wrap; word-break: break-word; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
  ul { margin: 4px 0; padding-left: 18px; } li { margin: 2px 0; }
  .muted { opacity: .7; } .small { font-size: .9em; }
  .banner { margin: 8px 0; padding: 6px 8px; border-left: 3px solid var(--vscode-editorInfo-foreground, #3794ff); background: var(--vscode-textBlockQuote-background); }
  .banner.warn { border-left-color: var(--vscode-editorWarning-foreground, #cca700); }
  .explain { white-space: pre-wrap; line-height: 1.45; }
  .stack li.active { font-weight: 600; }
  .ok { color: var(--vscode-testing-iconPassed, #73c991); } .no { color: var(--vscode-descriptionForeground); }
  a { color: var(--vscode-textLink-foreground); cursor: pointer; }
</style>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');
  const send = (command) => vscode.postMessage({ command });

  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) for (const k of Object.keys(props)) {
      if (k === 'class') node.className = props[k];
      else if (k === 'onclick') node.addEventListener('click', props[k]);
      else if (k === 'disabled') node.disabled = !!props[k];
      else node.setAttribute(k, props[k]);
    }
    for (const c of [].concat(children || [])) node.append(c);
    return node;
  }
  const text = (s) => document.createTextNode(String(s));
  const base = (p) => String(p).split('/').pop();
  const button = (label, command, disabled, secondary) =>
    el('button', { class: secondary ? 'secondary' : '', disabled, onclick: () => send(command), title: label }, text(label));

  function render(state) {
    root.replaceChildren();
    const f = state.flow;
    root.append(el('h2', null, text('Code Flow Explorer')));

    if (!f) {
      root.append(
        el('p', null, text('Step through the logic of a function without running it.')),
        el('p', { class: 'muted' }, text('Put the cursor inside a TypeScript, JavaScript or Go function, then start an exploration.')),
        el('div', { class: 'row' }, button('Explore from Here', 'explore', false))
      );
      renderAi(state, false);
      return;
    }

    root.append(el('dl', { class: 'kv' }, [
      el('dt', null, text('Flow')), el('dd', null, text(f.flowName)),
      el('dt', null, text('Step')), el('dd', null, text(f.stepNumber + ' of ' + f.stepCount)),
      el('dt', null, text('Function')), el('dd', null, text(f.functionName)),
      el('dt', null, text('File')), el('dd', { title: f.file }, text(base(f.file))),
    ]));

    if (f.message) root.append(el('div', { class: 'banner' + (f.stale ? ' warn' : '') }, text(f.message)));

    root.append(el('h2', null, text('Current step' + (f.step.awaits ? ' (awaits)' : ''))));
    root.append(el('pre', null, text(f.step.label)));
    root.append(el('div', { class: 'small muted' }, text('kind: ' + f.step.kind + (f.atEnd ? ' · end of function' : ''))));

    if (f.step.calls.length) {
      root.append(el('h2', null, text('Calls')));
      root.append(el('ul', null, f.step.calls.map((c) =>
        el('li', { title: c.note || '' }, [
          el('span', { class: c.canStepInto ? 'ok' : 'no' }, text(c.canStepInto ? '→ ' : '× ')),
          text(c.text),
          c.canStepInto ? text('') : el('span', { class: 'small muted' }, text(' — cannot step into')),
        ]))));
    }

    if (f.step.branches.length > 1) {
      root.append(el('h2', null, text('Possible paths')));
      root.append(el('ul', null, f.step.branches.map((b) => el('li', null, text(b.label)))));
      root.append(el('div', { class: 'small muted' }, text('Next asks which path to explore; nothing is assumed about runtime values.')));
    }

    root.append(el('h2', null, text('Call stack')));
    root.append(el('ul', { class: 'stack' }, f.callStack.map((fr, i) =>
      el('li', { class: i === f.callStack.length - 1 ? 'active' : '', title: fr.file + ':' + fr.line },
        text(fr.functionName + '  ' + base(fr.file) + ':' + fr.line))).reverse()));

    if (f.warnings.length) {
      root.append(el('h2', null, text('Analysis notes')));
      root.append(el('ul', { class: 'small muted' }, f.warnings.map((w) => el('li', null, text(w)))));
    }

    const dis = f.stale;
    root.append(el('div', { class: 'row' }, [
      button('Previous', 'previous', dis || !f.canGoBack, true),
      button('Next', 'next', dis),
      button('Step Into', 'stepInto', dis || !f.canStepInto),
      button('Step Out', 'stepOut', dis || !f.canStepOut, true),
    ]));
    root.append(el('div', { class: 'row' }, [button('Stop Exploration', 'stop', false, true)]));

    renderAi(state, !dis);
  }

  function renderAi(state, canExplain) {
    root.append(el('h2', null, text('AI explanation')));
    const ai = state.ai;
    let status;
    if (ai.state === 'disabled') status = 'AI explanations are disabled. No code is sent anywhere.';
    else if (ai.state === 'missing-key') status = 'No API key configured. Navigation works without AI.';
    else status = 'Pressing Explain sends the current step and its enclosing function to ' + (ai.label || 'the AI provider') + '.';
    root.append(el('div', { class: 'small muted' }, text(status)));

    const e = state.explanation;
    if (e.state === 'loading') root.append(el('div', { class: 'banner' }, text('Asking ' + (ai.label || 'the AI provider') + '…')));
    else if (e.state === 'ok') {
      root.append(el('div', { class: 'explain banner' }, text(e.text)));
      root.append(el('div', { class: 'small muted' }, text('Generated by ' + e.provider + ' (' + e.model + ') from the source shown; static reading, not an execution trace.')));
    } else if (e.state === 'notice') root.append(el('div', { class: 'banner warn' }, text(e.text)));

    if (canExplain) root.append(el('div', { class: 'row' }, [button('Explain Step', 'explain', ai.state === 'disabled' || e.state === 'loading')]));
    root.append(el('div', { class: 'row' }, [
      button('Provider', 'selectProvider', false, true),
      button('API Key', 'configureApiKey', false, true),
      button('Model', 'selectModel', false, true),
      button('Test', 'testConnection', false, true),
      button(ai.state === 'disabled' ? 'Enable AI' : 'Disable AI', 'toggleAi', false, true),
    ]));
  }

  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'state') render(event.data.state);
  });
  render({ flow: null, ai: { state: 'missing-key' }, explanation: { state: 'none' } });
  vscode.postMessage({ command: 'ready' });
})();
</script>
</body>
</html>`;
}
