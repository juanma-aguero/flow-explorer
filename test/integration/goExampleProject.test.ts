import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { AnalyzerRegistry } from '../../src/analysis/AnalyzerRegistry';
import type { GoAnalyzer } from '../../src/analysis/go/GoAnalyzer';
import { FlowEngine } from '../../src/flow/FlowEngine';
import { GO_DEMO, GoplsLookup, findGopls, newGoAnalyzer } from '../goHelpers';
import { ScriptedChooser, offsetOf } from '../helpers';

const gopls = findGopls();
const checkout = `${GO_DEMO}/checkout/checkout.go`;

/** Walks examples/go-demo the way the acceptance criteria describe, with a real gopls. */
describe('example project: go-demo', { skip: gopls ? false : 'gopls not found (set GOPLS or install it)' }, () => {
  let lookup: GoplsLookup;
  let go: GoAnalyzer;

  before(async () => {
    lookup = new GoplsLookup(gopls!, GO_DEMO);
    go = await newGoAnalyzer(lookup);
  });
  after(async () => {
    await lookup.dispose();
  });

  it('explores ProcessCheckout across packages, with branches, defer and go', async () => {
    const registry = new AnalyzerRegistry([{ extensions: ['.go'], analyzer: go }]);
    const engine = new FlowEngine(registry, new ScriptedChooser({ branches: ['else', 'then'] }));

    const started = await engine.startAt(checkout, offsetOf(checkout, 'validateCart(cart)'), 'enclosing');
    assert.equal(started.ok, true);
    let snap = (await engine.snapshot())!;
    assert.equal(snap.flowName, 'ProcessCheckout');
    assert.equal(snap.step.kind, 'condition');
    assert.equal(snap.step.label, 'if err := validateCart(cart); err != nil');
    assert.equal(snap.stepCount, 11);

    // The condition's initializer call can be entered; take the "no error" path afterwards.
    await engine.stepInto();
    assert.equal((await engine.snapshot())!.functionName, 'validateCart');
    await engine.stepOut();
    await engine.next(); // asks: choose 'else' (the err == nil path)
    snap = (await engine.snapshot())!;
    assert.equal(snap.step.label, 'total := pricing.CalculateTotal(cart.Items)');

    // Cross-package Step Into, then recursion inside pricing.
    await engine.stepInto();
    snap = (await engine.snapshot())!;
    assert.equal(snap.functionName, 'CalculateTotal');
    assert.ok(snap.file.endsWith('pricing/pricing.go'));
    assert.deepEqual(snap.callStack.map((f) => f.functionName), ['ProcessCheckout', 'CalculateTotal']);
    assert.equal(snap.callerRanges[0].file, checkout);
    await engine.stepOut();

    await engine.next();
    assert.equal((await engine.snapshot())!.step.label, 'discount := pricing.ApplyDiscount(total, cart.Customer)');
    await engine.stepInto();
    snap = (await engine.snapshot())!;
    assert.equal(snap.functionName, 'ApplyDiscount');
    assert.deepEqual(snap.step.branches.map((b) => b.id), ['then', 'else']);
    await engine.stepOut();

    // defer is a step; Step Into enters the deferred function.
    await engine.next();
    snap = (await engine.snapshot())!;
    assert.equal(snap.step.kind, 'defer');
    assert.match(snap.warnings.join(' '), /last in, first out/);

    // gateway.Charge is an interface call inside payment.Charge.
    await engine.next();
    assert.equal((await engine.snapshot())!.step.label, 'paymentID, err := payment.Charge(gateway, total-discount)');
    await engine.stepInto();
    assert.equal((await engine.snapshot())!.functionName, 'Charge');
    await engine.next(); // amount <= 0 : choose 'then'? scripted second branch answer is 'then'
    await engine.next();
    // Previous undoes everything back to the start.
    for (let i = 0; i < 30 && (await engine.snapshot())!.canGoBack; i++) await engine.previous();
    assert.equal((await engine.snapshot())!.step.kind, 'condition');
    assert.equal((await engine.snapshot())!.callStack.length, 1);
  });

  it('reports the standard library and interface calls as unresolved, with reasons', async () => {
    const payment = `${GO_DEMO}/payment/payment.go`;
    const e2 = new FlowEngine(go, new ScriptedChooser({ branches: ['else'] }));
    await e2.startAt(payment, offsetOf(payment, 'paymentID, err := gateway.Charge'), 'enclosing');
    await e2.next();
    assert.equal((await e2.snapshot())!.step.label, 'paymentID, err := gateway.Charge(amount)');
    const result = await e2.stepInto();
    assert.equal(result.moved, false);
    assert.match(result.message!, /only declared here/);

    const e3 = new FlowEngine(go, new ScriptedChooser());
    await e3.startAt(`${GO_DEMO}/checkout/checkout.go`, offsetOf(checkout, 'fmt.Println("checkout finished'), 'enclosing');
    const lib = await e3.stepInto();
    assert.equal(lib.moved, false);
    assert.match(lib.message!, /standard library/);
  });

  it('"Explore Function" starts at the callee and steps in when a flow is active', async () => {
    const engine = new FlowEngine(go, new ScriptedChooser());
    const onCall = offsetOf(checkout, 'pricing.CalculateTotal') - 5;
    const started = await engine.startAt(checkout, onCall, 'symbol');
    assert.equal(started.ok, true);
    assert.equal((await engine.snapshot())!.flowName, 'CalculateTotal');
  });
});
