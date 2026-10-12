/** Runs inside the VS Code extension host with examples/go-demo as the workspace and the real Go extension (gopls). */
import * as assert from 'assert';
import * as vscode from 'vscode';
import { exec, expectAt, goDemo, open, runSuite, sleep, Suite, waitForGopls } from './util';

const tests: Suite = [
  ['explore, branch, step into another package and back (real gopls)', async () => {
    if (!vscode.extensions.getExtension('golang.go')) {
      console.log('         (skipped: Go extension not installed)');
      return;
    }
    const checkout = goDemo('checkout', 'checkout.go');
    assert.ok(await waitForGopls(checkout, 'pricing.CalculateTotal'), 'gopls became ready');
    await open(checkout, 'validateCart(cart); err');
    await exec('codeFlow.exploreFromHere');
    await expectAt(checkout, 'if err := validateCart(cart); err != nil');

    const pending = exec('codeFlow.next');
    await sleep(600);
    await exec('workbench.action.quickOpenSelectNext'); // the err == nil path
    await exec('workbench.action.acceptSelectedQuickOpenItem');
    await pending;
    await expectAt(checkout, 'total := pricing.CalculateTotal(cart.Items)');

    await exec('codeFlow.stepInto');
    await expectAt(goDemo('pricing', 'pricing.go'), 'total := 0.0');
    await exec('codeFlow.stepOut');
    await expectAt(checkout, 'total := pricing.CalculateTotal(cart.Items)');
    await exec('codeFlow.stop');
  }],

];

export const run = (): Promise<void> => runSuite(tests);
