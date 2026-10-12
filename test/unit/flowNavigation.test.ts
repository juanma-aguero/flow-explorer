import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FlowEngine } from '../../src/flow/FlowEngine';
import { fixture, functionAt, newAnalyzer, ScriptedChooser } from '../helpers';

async function engineFor(file: string, needle: string, script: ConstructorParameters<typeof ScriptedChooser>[0] = {}) {
  const analyzer = newAnalyzer();
  const chooser = new ScriptedChooser(script);
  const engine = new FlowEngine(analyzer, chooser);
  const started = await engine.startFromFunction(await functionAt(analyzer, file, needle));
  assert.equal(started.ok, true);
  return { engine, chooser, analyzer };
}
const label = async (engine: FlowEngine): Promise<string> => (await engine.snapshot())!.step.label;

describe('FlowEngine: Next / Previous', () => {
  const shapes = fixture('shapes.ts');

  it('moves forward and backward through the steps', async () => {
    const { engine } = await engineFor(shapes, 'function sequence');
    assert.equal((await label(engine)), 'const x = work(a);');
    assert.equal((await engine.snapshot())!.stepNumber, 1);
    assert.equal((await engine.snapshot())!.stepCount, 5);

    await engine.next();
    assert.equal((await label(engine)), 'let y = x + 1;');
    await engine.next();
    await engine.next();
    assert.equal((await label(engine)), 'work();');

    await engine.previous();
    assert.equal((await label(engine)), 'y = work(y);');
    await engine.previous();
    await engine.previous();
    await engine.previous();
    assert.equal((await label(engine)), 'const x = work(a);');
    assert.equal((await engine.snapshot())!.canGoBack, false);
  });

  it('refuses to go before the first step and past the last one, with a message', async () => {
    const { engine } = await engineFor(shapes, 'function sequence');
    const before = await engine.previous();
    assert.equal(before.moved, false);
    assert.match(before.message!, /first step/);

    for (let i = 0; i < 4; i++) await engine.next();
    assert.equal((await engine.snapshot())!.atEnd, true);
    const after = await engine.next();
    assert.equal(after.moved, false);
    assert.match(after.message!, /end of `sequence`/);
  });

  it('does nothing and explains when no exploration is active', async () => {
    const engine = new FlowEngine(newAnalyzer(), new ScriptedChooser());
    const result = await engine.next();
    assert.equal(result.moved, false);
    assert.match(result.message!, /No active exploration/);
    assert.equal((await engine.snapshot()), undefined);
  });
});

describe('FlowEngine: conditional branches', () => {
  const shapes = fixture('shapes.ts');

  it('asks which branch to explore and follows the choice', async () => {
    const { engine, chooser } = await engineFor(shapes, 'function branching', { branches: ['else'] });
    assert.equal((await engine.snapshot())!.step.branches.length, 2);
    await engine.next();
    assert.equal((await label(engine)), 'work(2);');
    assert.deepEqual(chooser.asked, ['branch:if (flag)']);
    assert.deepEqual([...engine.session!.selectedBranches], [[(await engine.snapshot())!.step.id.replace(/s\d+$/, 's0'), 'else']]);
  });

  it('lets the user explore the other branch after going back', async () => {
    const { engine } = await engineFor(shapes, 'function branching', { branches: ['else', 'then'] });
    await engine.next();
    assert.equal((await label(engine)), 'work(2);');
    await engine.previous();
    assert.equal((await label(engine)), 'if (flag)');
    await engine.next();
    assert.equal((await label(engine)), 'work(1);');
  });

  it('stays put when the user cancels the choice', async () => {
    const { engine } = await engineFor(shapes, 'function branching', { branches: [undefined] });
    const result = await engine.next();
    assert.equal(result.moved, false);
    assert.equal((await label(engine)), 'if (flag)');
  });

  it('does not ask when all branches lead to the same place', async () => {
    const { engine, chooser } = await engineFor(shapes, 'function emptyIf');
    await engine.next();
    assert.equal(chooser.asked.length, 0);
    assert.equal((await label(engine)), 'work(1);');
  });

  it('exposes try/catch as a choice between the normal and exception path', async () => {
    const { engine } = await engineFor(shapes, 'function tryCatch', { branches: ['catch'] });
    await engine.next();
    assert.equal((await engine.snapshot())!.step.kind, 'catch');
  });
});

describe('FlowEngine: Step Into / Step Out', () => {
  const unresolved = fixture('unresolved.ts');

  it('steps into a local function and back out to the same call site', async () => {
    const { engine } = await engineFor(unresolved, 'function callsLocal');
    const before = (await engine.snapshot())!;
    assert.equal(before.canStepInto, true);
    assert.equal(before.canStepOut, false);

    const into = await engine.stepInto();
    assert.equal(into.moved, true);
    const inside = (await engine.snapshot())!;
    assert.equal(inside.functionName, 'local');
    assert.deepEqual(inside.callStack.map((f) => f.functionName), ['callsLocal', 'local']);
    assert.equal(inside.canStepOut, true);
    assert.equal(inside.callerRanges.length, 1);
    assert.equal(inside.callerRanges[0].start.line, before.step.range.start.line);

    const out = await engine.stepOut();
    assert.equal(out.moved, true);
    const back = (await engine.snapshot())!;
    assert.equal(back.functionName, 'callsLocal');
    assert.equal(back.step.id, before.step.id, 'returns to the call-site step');
  });

  it('Previous undoes Step Into and Step Out exactly', async () => {
    const { engine } = await engineFor(unresolved, 'function callsLocal');
    await engine.stepInto();
    await engine.stepOut();
    await engine.previous(); // undo step out -> back inside local
    assert.equal((await engine.snapshot())!.functionName, 'local');
    await engine.previous(); // undo step in -> back in caller
    assert.equal((await engine.snapshot())!.functionName, 'callsLocal');
    assert.equal((await engine.snapshot())!.callStack.length, 1);
  });

  it('Next at the end of a callee returns to the caller', async () => {
    const { engine } = await engineFor(unresolved, 'function callsLocal');
    await engine.stepInto();
    const result = await engine.next();
    assert.equal(result.moved, true);
    assert.match(result.message!, /back in `callsLocal`/);
    assert.equal((await engine.snapshot())!.functionName, 'callsLocal');
  });

  it('explains instead of failing when Step Out has no caller', async () => {
    const { engine } = await engineFor(unresolved, 'function callsLocal');
    const result = await engine.stepOut();
    assert.equal(result.moved, false);
    assert.match(result.message!, /no caller/);
  });

  it('refuses to step into unresolved symbols and says why', async () => {
    const { engine } = await engineFor(unresolved, 'function callsEverything', { calls: ['JSON.stringify', 'gateway.charge'] });
    // step 0: gateway.charge(1) is the only call (declaration-only)
    let result = await engine.stepInto();
    assert.equal(result.moved, false);
    assert.match(result.message!, /only declared here/);
    assert.equal((await engine.snapshot())!.callStack.length, 1);

    await engine.next();
    assert.deepEqual((await engine.snapshot())!.step.calls, [
      { text: 'JSON.stringify', canStepInto: false, note: (await engine.snapshot())!.step.calls[0].note },
    ]);
    result = await engine.stepInto();
    assert.match(result.message!, /library or declaration file/);
    assert.equal((await engine.snapshot())!.message, result.message, 'message is surfaced to the panel');
  });

  it('refuses to step into a step without calls', async () => {
    const { engine } = await engineFor(fixture('shapes.ts'), 'function sequence');
    await engine.next(); // let y = x + 1;
    const result = await engine.stepInto();
    assert.equal(result.moved, false);
    assert.match(result.message!, /no function call/);
  });

  it('asks which call to enter when a step has several', async () => {
    const { engine, chooser } = await engineFor(unresolved, 'function multi', { calls: ['other'] });
    assert.deepEqual((await engine.snapshot())!.step.calls.map((c) => c.text), ['local', 'other']);
    await engine.stepInto();
    assert.equal((await engine.snapshot())!.functionName, 'other');
    assert.deepEqual(chooser.asked, ['call:return local() + other();']);
  });

  it('stays put when the user cancels the call choice', async () => {
    const { engine } = await engineFor(unresolved, 'function multi', { calls: [undefined] });
    const result = await engine.stepInto();
    assert.equal(result.moved, false);
    assert.equal((await engine.snapshot())!.functionName, 'multi');
  });
});

describe('FlowEngine: recursion', () => {
  const file = fixture('recursion.ts');

  it('does not re-enter a function that is already on the call stack', async () => {
    const { engine } = await engineFor(file, 'function factorial', { branches: ['else'] });
    await engine.next(); // else branch: skip -> return n * factorial(n - 1)
    assert.equal((await engine.snapshot())!.step.kind, 'return');
    const result = await engine.stepInto();
    assert.equal(result.moved, false);
    assert.match(result.message!, /already on the call stack \(recursion\)/);
    assert.equal((await engine.snapshot())!.callStack.length, 1);
  });

  it('detects mutual recursion at the point it would loop', async () => {
    const { engine } = await engineFor(file, 'function ping');
    assert.equal((await engine.stepInto()).moved, true); // ping -> pong
    assert.equal((await engine.snapshot())!.functionName, 'pong');
    const again = await engine.stepInto(); // pong -> ping (already on stack)
    assert.equal(again.moved, false);
    assert.match(again.message!, /`ping` is already on the call stack/);
    assert.deepEqual((await engine.snapshot())!.callStack.map((f) => f.functionName), ['ping', 'pong']);
  });
});

describe('FlowEngine: starting and staleness', () => {
  it('reports a clear error when the cursor is not inside any function', async () => {
    const engine = new FlowEngine(newAnalyzer(), new ScriptedChooser());
    const result = await engine.startAt(fixture('shapes.ts'), 0, 'enclosing');
    assert.equal(result.ok, false);
    assert.match((result as { message: string }).message, /No function found/);
    assert.equal(engine.isActive, false);
  });

  it('reports an empty function instead of starting', async () => {
    const analyzer = newAnalyzer();
    const engine = new FlowEngine(analyzer, new ScriptedChooser());
    const result = await engine.startFromFunction(await functionAt(analyzer, fixture('shapes.ts'), 'function empty'));
    assert.equal(result.ok, false);
  });

  it('disables navigation once a visited file changes', async () => {
    const { engine } = await engineFor(fixture('shapes.ts'), 'function sequence');
    engine.notifyFileChanged(fixture('shapes.ts'));
    assert.equal((await engine.snapshot())!.stale, true);
    const result = await engine.next();
    assert.equal(result.moved, false);
    assert.match(result.message!, /source changed/);
    engine.stop();
    assert.equal(engine.isActive, false);
  });

  it('notifies listeners on every change', async () => {
    const { engine } = await engineFor(fixture('shapes.ts'), 'function sequence');
    let count = 0;
    const sub = engine.onDidChange(() => count++);
    await engine.next();
    await engine.previous();
    engine.stop();
    sub.dispose();
    await engine.startFromFunction(await functionAt(newAnalyzer(), fixture('shapes.ts'), 'function sequence'));
    assert.equal(count, 3);
  });
});
