import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { GoAnalyzer } from '../../src/analysis/go/GoAnalyzer';
import { FlowEngine } from '../../src/flow/FlowEngine';
import type { CallResolution } from '../../src/flow/FlowTypes';
import { GO_FIXTURES, GoplsLookup, findGopls, newGoAnalyzer, noDefinitions } from '../goHelpers';
import { ScriptedChooser, offsetOf } from '../helpers';

const gopls = findGopls();
const cross = `${GO_FIXTURES}/cross/cross.go`;
const reasonOf = (r: CallResolution): string => (r.kind === 'unresolved' ? r.reason : 'resolved');

describe('Go symbol resolution (real gopls)', { skip: gopls ? false : 'gopls not found (set GOPLS or install it)' }, () => {
  let lookup: GoplsLookup;
  let analyzer: GoAnalyzer;

  before(async () => {
    lookup = new GoplsLookup(gopls!, GO_FIXTURES);
    analyzer = await newGoAnalyzer(lookup);
  });
  after(async () => {
    await lookup.dispose();
  });

  async function callsOf(needle: string): Promise<Record<string, CallResolution>> {
    const fn = (await analyzer.findFunctionAt(cross, offsetOf(cross, needle)))!;
    const flow = await analyzer.getFlow(fn);
    const out: Record<string, CallResolution> = {};
    for (const call of flow.steps.flatMap((s) => s.calls)) out[call.text] = await analyzer.resolveCall(call);
    return out;
  }

  it('resolves same-package, cross-package and concrete method calls; explains the rest', async () => {
    const calls = await callsOf('func Run');
    const target = (text: string): string =>
      calls[text].kind === 'resolved' ? `${calls[text].targets[0].name}@${calls[text].targets[0].file.split('/').slice(-2).join('/')}` : 'unresolved';

    assert.equal(target('helper'), 'helper@cross/cross.go');
    assert.equal(target('shapes.Sequence'), 'Sequence@shapes/shapes.go');
    assert.equal(target('e.Greet'), 'English.Greet@cross/cross.go', 'concrete receiver type is known statically');

    assert.equal(reasonOf(calls['g.Greet']), 'declaration-only', 'interface method: implementation depends on runtime value');
    assert.equal(reasonOf(calls['strings.ToUpper']), 'external-library');
    assert.equal(reasonOf(calls['fmt.Println']), 'external-library');
    assert.equal(reasonOf(calls['handlers["x"]']), 'dynamic', 'func value from a map parameter');
    assert.equal(reasonOf(calls['cb']), 'dynamic', 'func value parameter');
    for (const [text, r] of Object.entries(calls)) {
      if (r.kind === 'unresolved') assert.ok(r.message.length > 20, `${text} has a readable reason`);
    }
  });

  it('resolves the identifier under the cursor, including declaration names without the server', async () => {
    const atCall = await analyzer.resolveSymbolAt(cross, offsetOf(cross, 'helper(msg)') - 6);
    assert.equal(atCall?.kind, 'resolved');

    const offline = await newGoAnalyzer(noDefinitions);
    const atDecl = await offline.resolveSymbolAt(cross, offsetOf(cross, 'func helper') - 1);
    assert.equal(atDecl?.kind, 'resolved', 'a declaration name needs no language server');
    if (atDecl?.kind === 'resolved') assert.equal(atDecl.targets[0].name, 'helper');
    assert.equal(await analyzer.resolveSymbolAt(cross, offsetOf(cross, 'return e.Greet') - 10), undefined, 'keyword is not an identifier');
  });

  it('steps into and out of Go functions through the engine', async () => {
    const engine = new FlowEngine(analyzer, new ScriptedChooser());
    const fn = (await analyzer.findFunctionAt(cross, offsetOf(cross, 'func Run')))!;
    await engine.startFromFunction(fn);
    assert.equal((await engine.snapshot())!.step.label, 'msg := g.Greet(name)');

    const refused = await engine.stepInto();
    assert.equal(refused.moved, false);
    assert.match(refused.message!, /only declared here/);

    await engine.next();
    const into = await engine.stepInto();
    assert.equal(into.moved, true);
    const snap = (await engine.snapshot())!;
    assert.equal(snap.functionName, 'helper');
    assert.deepEqual(snap.callStack.map((f) => f.functionName), ['Run', 'helper']);

    await engine.stepOut();
    assert.equal((await engine.snapshot())!.step.label, 'local := helper(msg)');
  });

  it('follows calls across packages', async () => {
    const engine = new FlowEngine(analyzer, new ScriptedChooser({ calls: ['shapes.Sequence'] }));
    await engine.startFromFunction((await analyzer.findFunctionAt(cross, offsetOf(cross, 'func Run')))!);
    for (let i = 0; i < 5; i++) await engine.next(); // msg, local, text, Println, handlers, cb -> shapes.Sequence
    await engine.next();
    assert.equal((await engine.snapshot())!.step.label, 'shapes.Sequence(1)');
    await engine.stepInto();
    const snap = (await engine.snapshot())!;
    assert.equal(snap.functionName, 'Sequence');
    assert.ok(snap.file.endsWith('shapes/shapes.go'));
  });

  it('does not re-enter recursive functions, direct or mutual', async () => {
    const engine = new FlowEngine(analyzer, new ScriptedChooser({ branches: ['else'] }));
    await engine.startFromFunction((await analyzer.findFunctionAt(cross, offsetOf(cross, 'func Fact')))!);
    await engine.next(); // choose the skip path of `if n <= 1`
    assert.equal((await engine.snapshot())!.step.kind, 'return');
    const direct = await engine.stepInto();
    assert.equal(direct.moved, false);
    assert.match(direct.message!, /recursion/);

    const mutual = new FlowEngine(analyzer, new ScriptedChooser());
    await mutual.startFromFunction((await analyzer.findFunctionAt(cross, offsetOf(cross, 'func Ping')))!);
    assert.equal((await mutual.stepInto()).moved, true);
    const again = await mutual.stepInto();
    assert.equal(again.moved, false);
    assert.match(again.message!, /`Ping` is already on the call stack/);
  });
});

describe('Go resolution without a language server', () => {
  it('says why instead of guessing', async () => {
    const analyzer = await newGoAnalyzer(noDefinitions);
    const fn = (await analyzer.findFunctionAt(cross, offsetOf(cross, 'func Run')))!;
    const flow = await analyzer.getFlow(fn);
    const resolution = await analyzer.resolveCall(flow.steps[1].calls[0]);
    assert.equal(resolution.kind, 'unresolved');
    assert.match((resolution as { message: string }).message, /gopls/);
  });

  it('survives a failing language server', async () => {
    const analyzer = await newGoAnalyzer({ definitions: async () => { throw new Error('boom'); } });
    const fn = (await analyzer.findFunctionAt(cross, offsetOf(cross, 'func Run')))!;
    const flow = await analyzer.getFlow(fn);
    const resolution = await analyzer.resolveCall(flow.steps[1].calls[0]);
    assert.match((resolution as { message: string }).message, /boom/);
  });
});
