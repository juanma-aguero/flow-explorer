import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FlowEngine } from '../../src/flow/FlowEngine';
import { demo, functionAt, newAnalyzer, offsetOf, ScriptedChooser } from '../helpers';

/** Walks the example project the way the acceptance criteria describe. */
describe('example project: checkout-demo', () => {
  const service = demo('src/checkout.service.ts');

  it('explores processCheckout across files, branches, step out and previous', async () => {
    const analyzer = newAnalyzer();
    const chooser = new ScriptedChooser({ branches: ['catch'], calls: [] });
    const engine = new FlowEngine(analyzer, chooser);

    // 1-3. Start from a cursor inside the function.
    const started = await engine.startAt(service, offsetOf(service, 'validateCart(cart);'), 'enclosing');
    assert.equal(started.ok, true);
    let snap = (await engine.snapshot())!;
    assert.equal(snap.flowName, 'processCheckout');
    assert.equal(snap.step.label, 'validateCart(cart);');
    assert.equal(snap.stepCount, 9);

    // Same-file helper: into validateCart and back out.
    await engine.stepInto();
    assert.equal((await engine.snapshot())!.functionName, 'validateCart');
    await engine.stepOut();

    // 4. Walk forward.
    await engine.next();
    snap = (await engine.snapshot())!;
    assert.equal(snap.step.label, 'const total = calculateTotal(cart.items);');

    // 5. Step into a function defined in another file (pricing.ts), which then calls into plain JS.
    await engine.stepInto();
    snap = (await engine.snapshot())!;
    assert.equal(snap.functionName, 'calculateTotal');
    assert.ok(snap.file.endsWith('src/pricing.ts'));
    assert.deepEqual(snap.callStack.map((f) => f.functionName), ['processCheckout', 'calculateTotal']);
    assert.equal(snap.callerRanges[0].file, service);

    // 6. Step out lands on the call site in the caller.
    await engine.stepOut();
    snap = (await engine.snapshot())!;
    assert.equal(snap.functionName, 'processCheckout');
    assert.equal(snap.step.label, 'const total = calculateTotal(cart.items);');

    // Async cross-file call, then the conditional inside it with a user choice.
    await engine.next();
    assert.equal((await engine.snapshot())!.step.awaits, true);
    await engine.stepInto();
    snap = (await engine.snapshot())!;
    assert.equal(snap.functionName, 'applyDiscount');
    assert.equal(snap.step.kind, 'condition');
    assert.deepEqual(snap.step.branches.map((b) => b.id), ['then', 'else']);
    await engine.stepOut();

    // 7. try/catch is a choice; take the catch path.
    await engine.next();
    assert.equal((await engine.snapshot())!.step.kind, 'try');
    await engine.next();
    snap = (await engine.snapshot())!;
    assert.equal(snap.step.kind, 'catch');
    await engine.next();
    assert.match((await engine.snapshot())!.step.label, /console\.error/);
    assert.equal((await engine.snapshot())!.step.calls[0].canStepInto, false, 'console.error lives in lib.d.ts');

    // Previous walks all the way back.
    for (let i = 0; i < 20 && (await engine.snapshot())!.canGoBack; i++) await engine.previous();
    assert.equal((await engine.snapshot())!.step.label, 'validateCart(cart);');
    assert.equal((await engine.snapshot())!.callStack.length, 1);
  });

  it('follows TypeScript -> JavaScript and handles recursion in pricing', async () => {
    const analyzer = newAnalyzer();
    const pricing = demo('src/pricing.ts');
    const engine = new FlowEngine(analyzer, new ScriptedChooser({ branches: ['body'] }));
    await engine.startFromFunction(await functionAt(analyzer, pricing, 'export function calculateTotal'));
    await engine.next(); // loop step
    await engine.next(); // choose body
    assert.equal((await engine.snapshot())!.step.label, 'total += itemTotal(item);');
    await engine.stepInto();
    assert.equal((await engine.snapshot())!.functionName, 'itemTotal');

    // itemTotal recurses into itself from its loop body.
    await engine.next();
    assert.equal((await engine.snapshot())!.step.kind, 'loop');
    const chooser = new ScriptedChooser({ branches: ['body'] });
    const e2 = new FlowEngine(analyzer, chooser);
    await e2.startFromFunction(await functionAt(analyzer, pricing, 'export function itemTotal'));
    await e2.next(); // loop
    await e2.next(); // choose the loop body
    assert.equal((await e2.snapshot())!.step.label, 'total += itemTotal(child);');
    const recursive = await e2.stepInto();
    assert.equal(recursive.moved, false);
    assert.match(recursive.message!, /recursion/);

    // JS module: calculateTotal -> roundMoney in legacy-money.js
    const e3 = new FlowEngine(analyzer, new ScriptedChooser({ branches: ['skip'] }));
    await e3.startFromFunction(await functionAt(analyzer, pricing, 'export function calculateTotal'));
    await e3.next();
    await e3.next(); // skip loop
    assert.equal((await e3.snapshot())!.step.label, 'return roundMoney(total);');
    await e3.stepInto();
    assert.ok((await e3.snapshot())!.file.endsWith('src/legacy-money.js'));
    assert.equal((await e3.snapshot())!.functionName, 'roundMoney');
  });

  it('"Explore Function" on a call starts from the callee, and steps in when a flow is active', async () => {
    const analyzer = newAnalyzer();
    const engine = new FlowEngine(analyzer, new ScriptedChooser());
    const cursorOnCall = offsetOf(service, 'applyDiscount(total') - 'total'.length - 1; // inside "applyDiscount"

    const started = await engine.startAt(service, cursorOnCall, 'symbol');
    assert.equal(started.ok, true);
    assert.equal((await engine.snapshot())!.flowName, 'applyDiscount');

    // With a flow already active on processCheckout, the same gesture steps into the call.
    const second = new FlowEngine(analyzer, new ScriptedChooser());
    await second.startAt(service, offsetOf(service, 'validateCart(cart);'), 'enclosing');
    await second.next();
    await second.next();
    assert.equal((await second.snapshot())!.step.label, 'const discount = await applyDiscount(total, cart.customer);');
    const into = await second.startAt(service, cursorOnCall, 'symbol');
    assert.equal(into.ok, true);
    assert.deepEqual((await second.snapshot())!.callStack.map((f) => f.functionName), ['processCheckout', 'applyDiscount']);
  });

  it('explains an unresolvable symbol when exploring from an interface call', async () => {
    const analyzer = newAnalyzer();
    const payment = demo('src/payment.ts');
    const engine = new FlowEngine(analyzer, new ScriptedChooser());
    const result = await engine.startAt(payment, offsetOf(payment, 'gateway.charge') - 2, 'symbol');
    assert.equal(result.ok, false);
    assert.match((result as { message: string }).message, /only declared here/);
  });
});
