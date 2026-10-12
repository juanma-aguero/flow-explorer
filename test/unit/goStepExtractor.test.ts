import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FlowStep, FunctionFlow } from '../../src/flow/FlowTypes';
import { GO_FIXTURES, newGoAnalyzer } from '../goHelpers';
import { offsetOf } from '../helpers';

const file = `${GO_FIXTURES}/shapes/shapes.go`;

async function flowOf(needle: string): Promise<FunctionFlow> {
  const analyzer = await newGoAnalyzer();
  const fn = await analyzer.findFunctionAt(file, offsetOf(file, needle));
  assert.ok(fn, `function at "${needle}"`);
  return analyzer.getFlow(fn);
}
const step = (flow: FunctionFlow, id: string | null): FlowStep => {
  const found = flow.steps.find((s) => s.id === id);
  assert.ok(found, `step ${id} exists`);
  return found;
};

describe('Go step extraction', () => {
  it('extracts statements in source order with kinds and calls', async () => {
    const flow = await flowOf('func Sequence');
    assert.deepEqual(flow.steps.map((s) => s.kind), ['assignment', 'assignment', 'assignment', 'call', 'return']);
    assert.deepEqual(flow.steps.map((s) => s.calls.map((c) => c.text)), [['work'], [], ['work'], ['work'], []]);
    assert.equal(flow.steps[0].text, 'x, _ := work(a)');
    assert.equal(flow.steps[0].range.start.line, 9);
    assert.equal(flow.function.name, 'Sequence');
    assert.match(flow.steps[0].id, /shapes\.go#Sequence@\d+\/s0$/);
    let cursor = flow.entry;
    const visited: number[] = [];
    while (cursor) {
      const s = step(flow, cursor);
      visited.push(s.index);
      cursor = s.next;
    }
    assert.deepEqual(visited, [0, 1, 2, 3, 4]);
  });

  it('models if/else with only the header highlighted', async () => {
    const flow = await flowOf('func Branching');
    const cond = flow.steps[0];
    assert.equal(cond.kind, 'condition');
    assert.equal(cond.text, 'if flag');
    const [thenB, elseB] = cond.branches;
    assert.equal(step(flow, thenB.target).text, 'work(1)');
    assert.equal(step(flow, elseB.target).text, 'work(2)');
    assert.equal(step(flow, thenB.target).next, flow.steps[3].id);
    assert.equal(step(flow, elseB.target).next, flow.steps[3].id);
  });

  it('includes an if initializer in the header and its calls, and chains else-if', async () => {
    const flow = await flowOf('func InitCondition');
    const cond = flow.steps[0];
    assert.equal(cond.text, 'if v, err := work(a); err != nil');
    assert.deepEqual(cond.calls.map((c) => c.text), ['work']);
    assert.equal(cond.branches[1].label, 'else-if branch');
    const nested = step(flow, cond.branches[1].target);
    assert.equal(nested.kind, 'condition');
    assert.equal(nested.text, 'if v > 1');
    assert.match(cond.branches[0].label, /err != nil/);
  });

  it('skips to the following statement when an if has no else', async () => {
    const flow = await flowOf('func IfWithoutElse');
    const [thenB, skip] = flow.steps[0].branches;
    assert.equal(step(flow, thenB.target).text, 'work(1)');
    assert.equal(step(flow, skip.target).text, 'work(2)');
  });

  it('models for and range loops as enter-body or skip, body visited once', async () => {
    const flow = await flowOf('func Loops');
    const loops = flow.steps.filter((s) => s.kind === 'loop');
    assert.deepEqual(loops.map((l) => l.text), ['for _, i := range items', 'for i := 0; i < 3; i++']);
    const [body, skip] = loops[0].branches;
    assert.equal(step(flow, body.target).text, 'v, _ := work(i)');
    assert.equal(step(flow, body.target).next === step(flow, step(flow, body.target).id).next, true);
    assert.equal(step(flow, skip.target).id, loops[1].id);
    assert.equal(step(flow, step(flow, body.target).next).kind, 'assignment');
  });

  it('has no implicit switch fallthrough, but honours the fallthrough keyword', async () => {
    const flow = await flowOf('func Switching');
    const sw = flow.steps.find((s) => s.kind === 'switch')!;
    assert.equal(sw.text, 'switch kind');
    assert.deepEqual(sw.branches.map((b) => b.label), ['case "a"', 'case "b"', 'case "c"', 'default']);
    const ret = flow.steps.find((s) => s.kind === 'return')!;
    const [a, b, c, d] = sw.branches.map((br) => br.target);
    assert.equal(step(flow, a).next, ret.id, 'case "a" ends the switch (no implicit fallthrough)');
    const fall = step(flow, step(flow, b).next);
    assert.equal(fall.kind, 'jump');
    assert.equal(fall.text, 'fallthrough');
    assert.equal(fall.next, c, 'fallthrough enters the next clause');
    assert.equal(step(flow, c).next, ret.id);
    assert.equal(step(flow, d).next, ret.id);
    assert.equal(sw.branches.length, 4, 'a default clause means no "no case matches" branch');
  });

  it('adds a "no case matches" branch without default, and models type switches', async () => {
    const flow = await flowOf('func TypeSwitch');
    const sw = flow.steps[0];
    assert.equal(sw.kind, 'switch');
    assert.deepEqual(sw.branches.map((b) => b.label), ['case int', 'case string, []byte', 'no case matches']);
    assert.equal(step(flow, sw.branches[0].target).kind, 'return');
  });

  it('models select with one branch per communication clause', async () => {
    const flow = await flowOf('func Selecting');
    const sel = flow.steps[0];
    assert.equal(sel.text, 'select');
    assert.deepEqual(sel.branches.map((b) => b.label), ['case v := <-ch', 'case <-done']);
  });

  it('models defer, go and panic distinctly, ignoring builtins and conversions', async () => {
    const flow = await flowOf('func DeferGoPanic');
    assert.deepEqual(flow.steps.map((s) => s.kind), ['defer', 'go', 'condition', 'throw', 'assignment']);
    assert.deepEqual(flow.steps[0].calls.map((c) => c.text), ['cleanup']);
    assert.deepEqual(flow.steps[1].calls.map((c) => c.text), ['work']);
    assert.deepEqual(flow.steps[2].calls.map((c) => c.text), [], 'len() is a builtin, not a step-into target');
    assert.deepEqual(flow.steps[4].calls, [], 'append() and int(3) are builtin/conversion');
    assert.equal(flow.steps[3].next, null, 'panic ends the flow');
    assert.ok(flow.warnings.some((w) => w.includes('defer')));
    assert.ok(flow.warnings.some((w) => w.includes('goroutines')));
    assert.ok(flow.warnings.some((w) => w.includes('panic')));
  });

  it('does not run function literal bodies, but treats an immediately-invoked literal as a call', async () => {
    const analyzer = await newGoAnalyzer();
    const fn = (await analyzer.findFunctionAt(file, offsetOf(file, 'func Literals')))!;
    const flow = await analyzer.getFlow(fn);
    assert.deepEqual(flow.steps.map((s) => s.kind), ['assignment', 'assignment', 'call', 'return']);
    assert.deepEqual(flow.steps[0].calls, [], 'work(99) lives in the literal body');
    assert.equal(flow.steps[2].calls.length, 1);
    const resolution = await analyzer.resolveCall(flow.steps[2].calls[0]);
    assert.equal(resolution.kind, 'resolved', 'the IIFE body does run right here');
    if (resolution.kind === 'resolved') assert.equal(resolution.targets[0].kind, 'function-expression');
  });

  it('names methods after their receiver and finds a function literal by its variable name', async () => {
    const flow = await flowOf('Run() int');
    assert.equal(flow.function.name, 'Service.Run');
    assert.equal(flow.function.kind, 'method');
    assert.deepEqual(flow.steps[0].calls.map((c) => c.text), ['s.step']);

    const analyzer = await newGoAnalyzer();
    const handler = await analyzer.findFunctionAt(file, offsetOf(file, 'handler'));
    assert.equal(handler?.name, 'handler');
  });

  it('handles empty functions and non-ASCII source positions', async () => {
    assert.equal((await flowOf('func Empty')).entry, null);
    const flow = await flowOf('func Unicode');
    const second = flow.steps[1];
    assert.equal(second.text, 'v, _ := work(len(s))');
    const lineText = (await import('node:fs')).readFileSync(file, 'utf8').split('\n')[second.range.start.line];
    assert.equal(lineText.slice(second.range.start.character, second.range.end.character), second.text, 'columns are UTF-16 units');
  });

  it('returns undefined outside any function', async () => {
    const analyzer = await newGoAnalyzer();
    assert.equal(await analyzer.findFunctionAt(file, 0), undefined);
  });
});
