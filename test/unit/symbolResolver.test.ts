import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CallResolution } from '../../src/flow/FlowTypes';
import { fixture, functionAt, newAnalyzer, offsetOf } from '../helpers';

async function resolveAll(file: string, needle: string): Promise<Array<{ text: string; resolution: CallResolution }>> {
  const analyzer = newAnalyzer();
  const flow = await analyzer.getFlow(await functionAt(analyzer, file, needle));
  return Promise.all(flow.steps.flatMap((s) => s.calls).map(async (call) => ({ text: call.text, resolution: await analyzer.resolveCall(call) })));
}

const reasonOf = (r: CallResolution): string => (r.kind === 'unresolved' ? r.reason : 'resolved');

describe('SymbolResolver', () => {
  const file = fixture('unresolved.ts');

  it('resolves a local function call to its implementation', async () => {
    const [call] = await resolveAll(file, 'function callsLocal');
    assert.equal(call.resolution.kind, 'resolved');
    if (call.resolution.kind === 'resolved') {
      assert.equal(call.resolution.targets[0].name, 'local');
      assert.equal(call.resolution.targets[0].file, file);
    }
  });

  it('explains every kind of unresolved call instead of guessing', async () => {
    const calls = await resolveAll(file, 'function callsEverything');
    const byText = Object.fromEntries(calls.map((c) => [c.text, c.resolution]));
    assert.equal(reasonOf(byText['gateway.charge']), 'declaration-only');
    assert.equal(reasonOf(byText['JSON.stringify']), 'external-library');
    assert.equal(reasonOf(byText['handlers[key]']), 'dynamic');
    assert.equal(reasonOf(byText['wrapped']), 'dynamic');
    assert.equal(reasonOf(byText['notDefinedAnywhere']), 'declaration-only');
    for (const c of calls) {
      assert.ok(c.resolution.kind === 'unresolved' && c.resolution.message.length > 10, `${c.text} has a readable reason`);
    }
  });

  it('reports a class without explicit constructor', async () => {
    const [call] = await resolveAll(file, 'function constructs');
    assert.equal(call.text, 'WithoutCtor');
    assert.equal(reasonOf(call.resolution), 'no-implementation');
  });

  it('follows imports, barrel re-exports and namespace imports across files', async () => {
    const entry = fixture('cross/entry.ts');
    const calls = await resolveAll(entry, 'function entry');
    const targets = calls.map((c) => (c.resolution.kind === 'resolved' ? `${c.resolution.targets[0].name}@${c.resolution.targets[0].file.split('/').slice(-2).join('/')}` : 'unresolved'));
    assert.deepEqual(targets, ['price@cross/model.ts', 'price@cross/model.ts', 'format@js/plain.js']);
  });

  it('resolves the identifier under the cursor (call target and declaration name)', async () => {
    const entry = fixture('cross/entry.ts');
    const analyzer = newAnalyzer();
    const atCall = await analyzer.resolveSymbolAt(entry, offsetOf(entry, 'price(sku)', 0) - 5);
    assert.equal(atCall?.kind, 'resolved');

    const model = fixture('cross/model.ts');
    const atDecl = await analyzer.resolveSymbolAt(model, offsetOf(model, 'function price') - 1);
    assert.equal(atDecl?.kind, 'resolved');
    if (atDecl?.kind === 'resolved') assert.equal(atDecl.targets[0].name, 'price');

    assert.equal(await analyzer.resolveSymbolAt(model, offsetOf(model, 'return') ), undefined, 'keyword is not an identifier');
  });

  it('works for plain JavaScript files', async () => {
    const js = fixture('js/plain.js');
    const calls = await resolveAll(js, 'function run');
    assert.equal(calls[0].text, 'format');
    assert.equal(calls[0].resolution.kind, 'resolved');
  });

  it('finds the function named by an arrow-function variable', async () => {
    const shapes = fixture('shapes.ts');
    const analyzer = newAnalyzer();
    const fn = await analyzer.findFunctionAt(shapes, offsetOf(shapes, 'arrowExpr'));
    assert.equal(fn?.name, 'arrowExpr');
    assert.equal(await analyzer.findFunctionAt(shapes, 0), undefined, 'top-level declarations are not inside a function');
  });
});
