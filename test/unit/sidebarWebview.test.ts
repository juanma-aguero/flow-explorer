import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import type { FlowSnapshot } from '../../src/flow/FlowTypes';
import { renderHtml } from '../../src/ui/sidebarHtml';

/** A tiny DOM, just enough to run the sidebar script and inspect what it renders. */
class Node_ {
  children: Array<Node_ | { text: string }> = [];
  attrs: Record<string, string> = {};
  className = '';
  disabled = false;
  style = { cssText: '' };
  listeners: Record<string, Array<() => void>> = {};
  constructor(readonly tag: string) {}
  append(...c: Array<Node_ | { text: string }>) { this.children.push(...c); }
  replaceChildren() { this.children = []; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  addEventListener(type: string, fn: () => void) { (this.listeners[type] ??= []).push(fn); }
  click() { this.listeners.click?.forEach((f) => f()); }
  get textContent(): string {
    return this.children.map((c) => ('text' in c ? c.text : c.textContent)).join('');
  }
  find(pred: (n: Node_) => boolean): Node_[] {
    const out: Node_[] = [];
    const walk = (n: Node_): void => {
      if (pred(n)) out.push(n);
      for (const c of n.children) if (!('text' in c)) walk(c);
    };
    walk(this);
    return out;
  }
  buttons(): Node_[] { return this.find((n) => n.tag === 'button'); }
}

function mount(): { root: Node_; posted: unknown[]; show(state: unknown): void } {
  const html = renderHtml('n0nce', 'vscode-resource:');
  const script = /<script nonce="n0nce">([\s\S]*?)<\/script>/.exec(html)![1];
  const root = new Node_('div');
  const posted: unknown[] = [];
  let onMessage: ((e: { data: unknown }) => void) | undefined;
  const sandbox = {
    document: { getElementById: () => root, createElement: (t: string) => new Node_(t), createTextNode: (s: unknown) => ({ text: String(s) }) },
    window: { addEventListener: (_: string, fn: (e: { data: unknown }) => void) => { onMessage = fn; } },
    acquireVsCodeApi: () => ({ postMessage: (m: unknown) => posted.push(JSON.parse(JSON.stringify(m))) }),
    navigator: { platform: 'MacIntel' },
  };
  vm.runInNewContext(script, sandbox);
  return { root, posted, show: (state) => onMessage!({ data: { type: 'state', state } }) };
}

const range = { file: '/p/a.ts', start: { line: 1, character: 0, offset: 0 }, end: { line: 1, character: 5, offset: 5 } };
function flow(over: Partial<FlowSnapshot> = {}, step: Partial<FlowSnapshot['step']> = {}): FlowSnapshot {
  return {
    flowName: 'processCheckout', functionName: 'processCheckout', file: '/p/checkout.ts', stepNumber: 2, stepCount: 5,
    step: { id: 's', kind: 'call', label: 'applyDiscount(total)', awaits: false, range, calls: [], branches: [], ...step },
    callStack: [{ functionName: 'processCheckout', file: '/p/checkout.ts', line: 7 }], callerRanges: [],
    canStepInto: true, canStepOut: false, canGoBack: true, atEnd: false, stale: false, warnings: [], ...over,
  };
}
const ai = { state: 'missing-key' as const };
const none = { state: 'none' as const };
const labels = (root: Node_): string[] => root.buttons().map((b) => b.textContent);
const button = (root: Node_, label: string): Node_ => {
  const found = root.buttons().find((b) => b.textContent.includes(label));
  assert.ok(found, `button "${label}" exists in: ${labels(root).join(' | ')}`);
  return found;
};

describe('sidebar webview', () => {
  it('shows a welcome with one clear action when nothing is active', () => {
    const { root, posted, show } = mount();
    show({ flow: null, ai, explanation: none });
    assert.match(root.textContent, /Explore code without running it/);
    button(root, 'Explore from Here').click();
    assert.deepEqual(posted.at(-1), { command: 'explore' });
  });

  it('keeps navigation in a toolbar and wires every button to its command', () => {
    const { root, posted, show } = mount();
    show({ flow: flow({ canStepOut: true }), ai, explanation: none });
    const toolbar = root.find((n) => n.attrs.role === 'toolbar')[0];
    assert.deepEqual(toolbar.buttons().map((b) => b.attrs['aria-label']), ['Previous', 'Next', 'Step Into', 'Step Out', 'Stop exploration']);
    for (const [label, command] of [['Previous', 'previous'], ['Next', 'next'], ['Step Into', 'stepInto'], ['Step Out', 'stepOut'], ['Stop', 'stop']]) {
      button(toolbar, label).click();
      assert.deepEqual(posted.at(-1), { command }, label);
    }
    assert.match(button(toolbar, 'Next').attrs.title, /F10/, 'shows the debugger-style shortcut');
    assert.match(button(toolbar, 'Step Into').attrs.title, /F11/);
  });

  it('disables what cannot be done', () => {
    const { root, show } = mount();
    show({ flow: flow({ canGoBack: false, canStepInto: false, canStepOut: false }), ai, explanation: none });
    assert.equal(button(root, 'Previous').disabled, true);
    assert.equal(button(root, 'Step Into').disabled, true);
    assert.equal(button(root, 'Step Out').disabled, true);
    assert.equal(button(root, 'Next').disabled, false);
  });

  it('turns branches into buttons that choose the path directly', () => {
    const { root, posted, show } = mount();
    show({ flow: flow({}, { kind: 'condition', branches: [{ id: 'then', label: 'if branch' }, { id: 'else', label: 'else branch' }] }), ai, explanation: none });
    assert.match(root.textContent, /Which way\?/);
    button(root, 'else branch').click();
    assert.deepEqual(posted.at(-1), { command: 'branch', id: 'else' });
  });

  it('lists calls: clickable when they can be entered, with the reason when not', () => {
    const { root, posted, show } = mount();
    show({
      flow: flow({}, { calls: [{ id: 'c1', text: 'fmt.Println', canStepInto: false, note: 'Library code is not explored.' }, { id: 'c2', text: 'helper', canStepInto: true }] }),
      ai, explanation: none,
    });
    assert.match(root.textContent, /Library code is not explored\./);
    assert.equal(root.buttons().some((b) => b.textContent.includes('fmt.Println')), false, 'unresolvable calls are not buttons');
    button(root, 'helper').click();
    assert.deepEqual(posted.at(-1), { command: 'stepIntoCall', id: 'c2' });
  });

  it('offers a restart when the session is stale and disables navigation', () => {
    const { root, posted, show } = mount();
    show({ flow: flow({ stale: true, message: 'The source changed.' }), ai, explanation: none });
    assert.equal(button(root, 'Next').disabled, true);
    button(root, 'Start over').click();
    assert.deepEqual(posted.at(-1), { command: 'explore' });
  });

  it('names the current function and where the flow started', () => {
    const { root, show } = mount();
    show({ flow: flow({ functionName: 'applyDiscount', canStepOut: true }), ai, explanation: none });
    const flowTitle = root.find((n) => n.className === 'flow')[0].textContent;
    assert.equal(flowTitle, 'applyDiscount');
    assert.match(root.find((n) => n.className.startsWith('where'))[0].textContent, /started from processCheckout/);
  });

  it('guides AI setup, explanation and opt-out without cluttering the panel', () => {
    const { root, posted, show } = mount();
    show({ flow: flow(), ai, explanation: none });
    button(root, 'Set up AI explanations').click();
    assert.deepEqual(posted.at(-1), { command: 'configureApiKey' });
    assert.equal(root.buttons().some((b) => b.textContent === 'Explain this step'), false, 'no explain button until AI is configured');
    assert.ok(root.find((n) => n.tag === 'details').length >= 1, 'AI settings live in a collapsed section');

    show({ flow: flow(), ai: { state: 'ready', label: 'OpenAI · gpt-5-mini' }, explanation: none });
    assert.match(root.textContent, /Sends this step and its function to OpenAI/);
    button(root, 'Explain this step').click();
    assert.deepEqual(posted.at(-1), { command: 'explain' });

    show({ flow: flow(), ai: { state: 'ready', label: 'OpenAI · gpt-5-mini' }, explanation: { state: 'ok', text: 'It applies a discount.', provider: 'OpenAI', model: 'gpt-5-mini' } });
    assert.match(root.textContent, /It applies a discount\./);
    assert.match(root.textContent, /not a trace of what runs/);

    show({ flow: flow(), ai: { state: 'disabled' }, explanation: none });
    assert.match(root.textContent, /No code is sent anywhere/);
    button(root, 'Turn on').click();
    assert.deepEqual(posted.at(-1), { command: 'toggleAi' });
  });

  it('never interprets text as HTML', () => {
    const { root, show } = mount();
    show({ flow: flow({}, { label: '<img src=x onerror=alert(1)>' }), ai, explanation: { state: 'notice', text: '<b>x</b>' } });
    assert.match(root.textContent, /<img src=x onerror=alert\(1\)>/);
    assert.equal(root.find((n) => n.tag === 'img').length, 0);
    assert.equal(root.find((n) => n.tag === 'b' && n.textContent === 'x').length, 0);
  });

  it('declares a strict content security policy with no inline style attributes', () => {
    const html = renderHtml('abc', 'vscode-resource:');
    assert.match(html, /default-src 'none'/);
    assert.match(html, /script-src 'nonce-abc'/);
    assert.equal(/\sstyle="/.test(html), false);
  });
});
