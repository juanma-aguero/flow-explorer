/** Runs inside the VS Code extension host. TypeScript scenarios against examples/checkout-demo. */
import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { demoFile, exec, expectAt, open, runSuite, sleep, Suite } from './util';

const tests: Suite = [
  ['activates and registers every command', async () => {
    const manifest = require(path.resolve(__dirname, '..', '..', '..', 'package.json')) as { contributes: { commands: Array<{ command: string }> } };
    await open(demoFile('checkout.service.ts'), 'validateCart(cart);');
    const ext = vscode.extensions.getExtension('local.code-flow-explorer');
    assert.ok(ext, 'extension is installed in the host');
    await ext.activate();
    const registered = new Set(await vscode.commands.getCommands(true));
    for (const { command } of manifest.contributes.commands) {
      assert.ok(registered.has(command), `${command} is registered`);
    }
  }],

  ['explore, next, step into another file, step out, previous, stop', async () => {
    const service = demoFile('checkout.service.ts');
    await open(service, 'validateCart(cart);');
    await exec('codeFlow.exploreFromHere');
    await expectAt(service, 'validateCart(cart);');

    await exec('codeFlow.next');
    await expectAt(service, 'const total = calculateTotal');

    await exec('codeFlow.stepInto');
    await expectAt(demoFile('pricing.ts'), 'let total = 0;');

    await exec('codeFlow.stepOut');
    await expectAt(service, 'const total = calculateTotal');

    await exec('codeFlow.previous'); // undo step out -> inside calculateTotal
    await expectAt(demoFile('pricing.ts'), 'let total = 0;');

    await exec('codeFlow.stop');
  }],

  ['asks which branch to explore through a Quick Pick', async () => {
    const pricing = demoFile('pricing.ts');
    await open(pricing, 'if (customer.isPremium)');
    await exec('codeFlow.exploreFromHere');
    await expectAt(pricing, 'if (customer.isPremium)');

    const pending = exec('codeFlow.next'); // blocks on the Quick Pick
    await sleep(600);
    await exec('workbench.action.quickOpenSelectNext'); // second option: else-if
    await exec('workbench.action.acceptSelectedQuickOpenItem');
    await pending;
    await expectAt(pricing, 'else if (total > 100)'); // the else-if branch leads to the nested condition

    const pending2 = exec('codeFlow.next'); // and that one is a choice again
    await sleep(600);
    await exec('workbench.action.acceptSelectedQuickOpenItem'); // first option: the if branch
    await pending2;
    await expectAt(pricing, 'return applyBulkDiscount(total);');
    await exec('codeFlow.stop');
  }],

  ['Explore Function on a call starts from the callee', async () => {
    const service = demoFile('checkout.service.ts');
    await open(service, 'applyDiscount(total');
    await exec('codeFlow.exploreFunction');
    await expectAt(demoFile('pricing.ts'), 'if (customer.isPremium)');
    await exec('codeFlow.stop');
  }],

  ['navigation works with no AI configured', async () => {
    const config = vscode.workspace.getConfiguration('codeFlow.ai');
    assert.strictEqual(config.get('autoExplain'), false, 'auto-explain is opt-in');
    const service = demoFile('checkout.service.ts');
    await open(service, 'validateCart(cart);');
    await exec('codeFlow.exploreFromHere');
    await exec('codeFlow.next');
    await expectAt(service, 'const total = calculateTotal');
    await exec('codeFlow.stop');
  }],
];


export const run = (): Promise<void> => runSuite(tests);
