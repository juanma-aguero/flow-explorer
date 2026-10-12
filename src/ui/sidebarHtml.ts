/**
 * The sidebar webview document. Plain HTML + a small script; no `vscode` import so it can be tested with a stub DOM.
 *
 * Design goals: the controls are always visible (sticky toolbar), the two decisions the user can make
 * (which path, which call) are buttons in the panel, and AI setup stays out of the way until it is needed.
 * All text goes through `textContent`, never `innerHTML`.
 */
export function renderHtml(nonce: string, cspSource: string): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  * { box-sizing: border-box; }
  body { margin: 0; padding: 0 0 20px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
  .pad { padding: 0 12px; }
  h3 { margin: 16px 0 6px; font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--vscode-descriptionForeground); }
  p { margin: 6px 0; line-height: 1.45; }
  .muted { color: var(--vscode-descriptionForeground); }
  .small { font-size: .92em; }
  code, .mono { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
  kbd { font-family: var(--vscode-editor-font-family); font-size: .9em; padding: 0 4px; border: 1px solid var(--vscode-widget-border, var(--vscode-contrastBorder, #8884)); border-radius: 3px; background: var(--vscode-keybindingLabel-background); }

  /* header + progress */
  .head { padding: 10px 12px 8px; }
  .flow { font-weight: 600; font-size: 1.1em; word-break: break-word; }
  .where { margin-top: 2px; word-break: break-word; }
  .progress { height: 3px; margin-top: 8px; border-radius: 2px; background: var(--vscode-widget-border, #8884); position: relative; overflow: hidden; }
  .progress > i { position: absolute; inset: 0 auto 0 0; background: var(--vscode-progressBar-background, var(--vscode-button-background)); }
  .stepcount { margin-top: 4px; }

  /* toolbar: always visible */
  .toolbar { position: sticky; top: 0; z-index: 2; display: grid; grid-template-columns: repeat(4, 1fr) auto; gap: 4px; padding: 8px 12px; background: var(--vscode-sideBar-background); border-bottom: 1px solid var(--vscode-sideBar-border, var(--vscode-widget-border, #8883)); }
  button { font: inherit; cursor: pointer; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border: 1px solid transparent; border-radius: 3px; padding: 5px 6px; }
  button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: .4; cursor: default; }
  button:focus-visible, summary:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .tb { display: flex; flex-direction: column; align-items: center; gap: 1px; line-height: 1.15; padding: 4px 2px; }
  .tb b { font-size: 15px; font-weight: normal; }
  .tb span { font-size: .85em; }
  .tb.stop { padding: 4px 8px; }

  /* current step */
  .kind { display: inline-block; margin-bottom: 4px; padding: 1px 7px; border-radius: 10px; font-size: .85em; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); }
  pre.step { margin: 4px 0 0; padding: 8px 10px; white-space: pre-wrap; word-break: break-word; background: var(--vscode-textCodeBlock-background); border-left: 3px solid var(--vscode-editorWarning-foreground, #cca700); border-radius: 0 3px 3px 0; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
  .endnote { margin-top: 6px; }

  /* choices */
  .choice { display: block; width: 100%; margin: 4px 0; text-align: left; padding: 6px 9px; line-height: 1.35; word-break: break-word; }
  .choice .arrow { margin-right: 6px; }
  .call { display: block; margin: 4px 0; }
  .call .why { margin: 2px 0 0 22px; }
  .nocall { opacity: .75; }

  /* messages */
  .banner { margin: 10px 12px 0; padding: 7px 10px; line-height: 1.4; border-left: 3px solid var(--vscode-editorInfo-foreground, #3794ff); background: var(--vscode-textBlockQuote-background); border-radius: 0 3px 3px 0; word-break: break-word; }
  .banner.warn { border-left-color: var(--vscode-editorWarning-foreground, #cca700); }

  /* stack */
  ol.stack { list-style: none; margin: 0; padding: 0; }
  ol.stack li { padding: 2px 0 2px 14px; position: relative; word-break: break-word; }
  ol.stack li::before { content: ''; position: absolute; left: 3px; top: .8em; width: 6px; height: 6px; border-radius: 50%; background: var(--vscode-descriptionForeground); opacity: .5; }
  ol.stack li.active { font-weight: 600; }
  ol.stack li.active::before { background: var(--vscode-button-background); opacity: 1; }

  /* AI */
  .card { margin: 6px 12px 0; padding: 10px; border: 1px solid var(--vscode-widget-border, #8883); border-radius: 4px; }
  .card .row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
  .card .row button { flex: 1 1 auto; }
  .explain { white-space: pre-wrap; line-height: 1.5; margin: 8px 0 0; }
  details { margin: 10px 12px 0; }
  summary { cursor: pointer; padding: 3px 0; color: var(--vscode-descriptionForeground); }
  details .row { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 6px; }
  ul.notes { margin: 6px 0 0; padding-left: 18px; } ul.notes li { margin: 3px 0; }

  /* welcome */
  .welcome ol { margin: 8px 0 12px; padding-left: 20px; line-height: 1.6; }
  .welcome .big { width: 100%; padding: 8px; font-size: 1.05em; }
</style>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');
  const isMac = /Mac|iPhone|iPad/.test((typeof navigator !== 'undefined' && navigator.platform) || '');
  // Same keys as the debugger; they only apply during an exploration, and never while debugging.
  const KEYS = isMac
    ? { next: 'F10', stepInto: 'F11', stepOut: '⇧F11', previous: '⌥F10', stop: '⇧F5' }
    : { next: 'F10', stepInto: 'F11', stepOut: 'Shift+F11', previous: 'Alt+F10', stop: 'Shift+F5' };
  const send = (command, id) => vscode.postMessage(id === undefined ? { command } : { command, id });

  const KIND = {
    assignment: 'Assignment', call: 'Function call', expression: 'Expression', condition: 'Condition',
    loop: 'Loop', switch: 'Switch', try: 'try block', catch: 'catch handler', finally: 'finally block',
    return: 'Return', throw: 'Throw / panic', jump: 'break / continue', defer: 'Deferred call', go: 'Goroutine start', other: 'Statement'
  };
  const KIND_HINT = {
    defer: 'Runs when the function returns, not here.',
    go: 'Starts running concurrently.',
    throw: 'Ends this path of the function.',
    try: 'Choose whether an exception is thrown.',
    loop: 'Shown as one pass through the body.'
  };

  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) for (const k of Object.keys(props)) {
      const v = props[k];
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'onclick') node.addEventListener('click', v);
      else if (k === 'disabled') node.disabled = true;
      else if (k === 'style') node.style.cssText = v; // CSSOM is allowed by the CSP; a style attribute is not
      else node.setAttribute(k, v);
    }
    for (const c of [].concat(children === undefined ? [] : children)) node.append(c);
    return node;
  }
  const text = (s) => document.createTextNode(String(s));
  const base = (p) => String(p).split('/').pop();
  const tip = (label, cmd) => KEYS[cmd] ? label + ' (' + KEYS[cmd] + ')' : label;

  function toolbarButton(icon, label, cmd, disabled, primary) {
    return el('button', { class: 'tb' + (primary ? ' primary' : ''), disabled, title: tip(label, cmd), 'aria-label': label, onclick: () => send(cmd) },
      [el('b', { 'aria-hidden': 'true' }, text(icon)), el('span', null, text(label))]);
  }

  function render(state) {
    root.replaceChildren();
    const f = state.flow;
    if (!f) return renderWelcome(state);

    const dead = f.stale;

    // header: where am I?
    root.append(el('div', { class: 'head' }, [
      el('div', { class: 'flow' }, text(f.functionName)),
      el('div', { class: 'where muted small', title: f.file }, text(base(f.file) + (f.functionName === f.flowName ? '' : ' · started from ' + f.flowName))),
      el('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '1', 'aria-valuemax': String(f.stepCount), 'aria-valuenow': String(f.stepNumber) },
        el('i', { style: 'width:' + Math.round((f.stepNumber / Math.max(f.stepCount, 1)) * 100) + '%' })),
      el('div', { class: 'stepcount muted small' }, text('Step ' + f.stepNumber + ' of ' + f.stepCount + ' in this function')),
    ]));

    // controls: always on top
    root.append(el('div', { class: 'toolbar', role: 'toolbar', 'aria-label': 'Flow navigation' }, [
      toolbarButton('◀', 'Previous', 'previous', dead || !f.canGoBack, false),
      toolbarButton('▶', 'Next', 'next', dead, true),
      toolbarButton('⤵', 'Step Into', 'stepInto', dead || !f.canStepInto, false),
      toolbarButton('⤴', 'Step Out', 'stepOut', dead || !f.canStepOut, false),
      el('button', { class: 'tb stop', title: tip('Stop exploration', 'stop'), 'aria-label': 'Stop exploration', onclick: () => send('stop') },
        [el('b', { 'aria-hidden': 'true' }, text('■')), el('span', null, text('Stop'))]),
    ]));

    if (f.message) root.append(el('div', { class: 'banner' + (dead ? ' warn' : ''), role: 'status', 'aria-live': 'polite' }, [
      text(f.message),
      dead ? el('div', null, el('button', { class: 'primary', style: 'margin-top:6px', onclick: () => send('explore') }, text('Start over from the cursor'))) : text(''),
    ]));

    // current step
    const kind = (KIND[f.step.kind] || 'Statement') + (f.step.awaits ? ' · awaits' : '');
    root.append(el('div', { class: 'pad' }, [
      el('h3', null, text('You are here')),
      el('span', { class: 'kind' }, text(kind)),
      el('pre', { class: 'step' }, text(f.step.label)),
      KIND_HINT[f.step.kind] ? el('div', { class: 'small muted endnote' }, text(KIND_HINT[f.step.kind])) : text(''),
      f.atEnd ? el('div', { class: 'small muted endnote' }, text(f.canStepOut ? 'End of this function. Next returns to the caller.' : 'End of the flow. Stop, or start another from the cursor.')) : text(''),
    ]));

    // decision 1: which way?
    if (f.step.branches.length > 1 && !dead) {
      root.append(el('div', { class: 'pad' }, [
        el('h3', null, text('Which way?')),
        el('div', { class: 'small muted' }, text('Static analysis cannot know what happens at runtime. Pick the path to follow:')),
        ...f.step.branches.map((b) => el('button', { class: 'choice', onclick: () => send('branch', b.id) }, [el('span', { class: 'arrow', 'aria-hidden': 'true' }, text('↳')), text(b.label)])),
      ]));
    }

    // decision 2: step into which call?
    if (f.step.calls.length) {
      root.append(el('div', { class: 'pad' }, [
        el('h3', null, text(f.step.calls.length > 1 ? 'Calls in this step' : 'Call in this step')),
        ...f.step.calls.map((c) => el('div', { class: 'call' + (c.canStepInto ? '' : ' nocall') }, [
          c.canStepInto
            ? el('button', { class: 'choice', disabled: dead, title: 'Step into ' + c.text, onclick: () => send('stepIntoCall', c.id) }, [el('span', { class: 'arrow', 'aria-hidden': 'true' }, text('⤵')), el('span', { class: 'mono' }, text(c.text))])
            : el('div', null, [el('span', { class: 'arrow', 'aria-hidden': 'true' }, text('⊘ ')), el('span', { class: 'mono' }, text(c.text))]),
          c.canStepInto ? text('') : el('div', { class: 'why small muted' }, text(c.note || 'Cannot be explored statically.')),
        ])),
      ]));
    }

    // call stack
    if (f.callStack.length > 1) {
      root.append(el('div', { class: 'pad' }, [
        el('h3', null, text('Call stack')),
        el('ol', { class: 'stack' }, f.callStack.map((fr, i) =>
          el('li', { class: i === f.callStack.length - 1 ? 'active' : '', title: fr.file + ':' + fr.line },
            text(fr.functionName + '  ' + base(fr.file) + ':' + fr.line))).reverse()),
      ]));
    }

    renderAi(state, !dead);

    if (f.warnings.length) {
      root.append(el('details', null, [
        el('summary', null, text('Analysis notes (' + f.warnings.length + ')')),
        el('ul', { class: 'notes small muted' }, f.warnings.map((w) => el('li', null, text(w)))),
      ]));
    }
  }

  function renderWelcome(state) {
    root.append(el('div', { class: 'pad welcome' }, [
      el('h3', null, text('Explore code without running it')),
      el('ol', null, [
        el('li', null, text('Click inside a function (TypeScript, JavaScript or Go).')),
        el('li', null, text('Press the button below.')),
        el('li', null, [text('Move like in the debugger: '), el('kbd', null, text(KEYS.next)), text(' next, '), el('kbd', null, text(KEYS.stepInto)), text(' step into, '), el('kbd', null, text(KEYS.stepOut)), text(' step out, '), el('kbd', null, text(KEYS.previous)), text(' back.')]),
      ]),
      el('button', { class: 'primary big', onclick: () => send('explore') }, text('Explore from Here')),
      el('p', { class: 'small muted' }, text('Tip: right-click in the editor for “Code Flow: Explore Function” to start from a function you are calling.')),
    ]));
    renderAi(state, false);
  }

  function renderAi(state, canExplain) {
    const ai = state.ai;
    const e = state.explanation;
    const card = [];

    if (ai.state === 'missing-key') {
      card.push(el('div', { class: 'small muted' }, text('Get a plain-language explanation of each step. Bring your own key; navigation works without it.')));
      card.push(el('div', { class: 'row' }, [el('button', { class: 'primary', onclick: () => send('configureApiKey') }, text('Set up AI explanations'))]));
    } else if (ai.state === 'disabled') {
      card.push(el('div', { class: 'small muted' }, text('AI explanations are off. No code is sent anywhere.')));
      card.push(el('div', { class: 'row' }, [el('button', { onclick: () => send('toggleAi') }, text('Turn on'))]));
    } else {
      if (e.state === 'ok') {
        card.push(el('div', { class: 'explain' }, text(e.text)));
        card.push(el('div', { class: 'small muted', style: 'margin-top:6px' }, text('By ' + e.provider + ' (' + e.model + '). A reading aid based on the code shown, not a trace of what runs.')));
      } else if (e.state === 'loading') {
        card.push(el('div', { role: 'status', 'aria-live': 'polite' }, text('Asking ' + (ai.label || 'the AI provider') + '…')));
      } else if (e.state === 'notice') {
        card.push(el('div', { class: 'small' }, text(e.text)));
      } else {
        card.push(el('div', { class: 'small muted' }, text(canExplain ? 'Sends this step and its function to ' + (ai.label || 'the AI provider') + '.' : 'Start an exploration to explain a step.')));
      }
      if (canExplain) {
        card.push(el('div', { class: 'row' }, [el('button', { class: e.state === 'ok' ? '' : 'primary', disabled: e.state === 'loading', onclick: () => send('explain') }, text(e.state === 'ok' ? 'Explain again' : 'Explain this step'))]));
      }
    }

    root.append(el('h3', { style: 'padding:0 12px' }, text('AI explanation')));
    root.append(el('div', { class: 'card' }, card));
    root.append(el('details', null, [
      el('summary', null, text('AI settings' + (ai.label ? ' · ' + ai.label : ''))),
      el('div', { class: 'row' }, [
        el('button', { onclick: () => send('selectProvider') }, text('Provider')),
        el('button', { onclick: () => send('selectModel') }, text('Model')),
        el('button', { onclick: () => send('configureApiKey') }, text('API key')),
        el('button', { onclick: () => send('testConnection') }, text('Test connection')),
        el('button', { onclick: () => send('toggleAi') }, text(ai.state === 'disabled' ? 'Turn on AI' : 'Turn off AI')),
      ]),
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
