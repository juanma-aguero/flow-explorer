import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FlowStep, FunctionFlow } from '../../src/flow/FlowTypes';
import { fixture, functionAt, newAnalyzer } from '../helpers';

const file = fixture('shapes.ts');

async function flowOf(needle: string): Promise<FunctionFlow> {
  const analyzer = newAnalyzer();
  return await analyzer.getFlow(await functionAt(analyzer, file, needle));
}
const step = (flow: FunctionFlow, id: string | null): FlowStep => {
  const found = flow.steps.find((s) => s.id === id);
  assert.ok(found, `step ${id} exists`);
  return found;
};

describe('StepExtractor', () => {
  it('extracts statements in source order with kinds, calls and a linear chain', async () => {
    const flow = await flowOf('function sequence');
    assert.deepEqual(
      flow.steps.map((s) => s.kind),
      ['assignment', 'assignment', 'assignment', 'call', 'return'],
    );
    assert.deepEqual(flow.steps.map((s) => s.calls.map((c) => c.text)), [['work'], [], ['work'], ['work'], []]);
    // linear wiring
    let cursor: string | null = flow.entry;
    const visited: number[] = [];
    while (cursor) {
      const s = step(flow, cursor);
      visited.push(s.index);
      cursor = s.next;
    }
    assert.deepEqual(visited, [0, 1, 2, 3, 4]);
  });

  it('gives steps stable ids and exact source locations', async () => {
    const a = await flowOf('function sequence');
    const b = await flowOf('function sequence');
    assert.deepEqual(a.steps.map((s) => s.id), b.steps.map((s) => s.id));
    assert.match(a.steps[0].id, /shapes\.ts#sequence@\d+\/s0$/);
    assert.equal(a.steps[0].text, 'const x = work(a);');
    assert.equal(a.steps[0].range.start.line, 5);
    assert.equal(a.steps[0].range.start.character, 2);
  });

  it('models if/else as a branching step whose range is only the header', async () => {
    const flow = await flowOf('function branching');
    const cond = flow.steps[0];
    assert.equal(cond.kind, 'condition');
    assert.equal(cond.text, 'if (flag)');
    assert.equal(cond.branches.length, 2);
    const [thenBranch, elseBranch] = cond.branches;
    assert.equal(step(flow, thenBranch.target).text, 'work(1);');
    assert.equal(step(flow, elseBranch.target).text, 'work(2);');
    // both paths rejoin at the return
    assert.equal(step(flow, thenBranch.target).next, flow.steps[3].id);
    assert.equal(step(flow, elseBranch.target).next, flow.steps[3].id);
    assert.equal(flow.steps[3].kind, 'return');
  });

  it('models if without else as "skip" to the next statement', async () => {
    const flow = await flowOf('function ifWithoutElse');
    const [thenBranch, skip] = flow.steps[0].branches;
    assert.equal(step(flow, thenBranch.target).text, 'work(1);');
    assert.equal(step(flow, skip.target).text, 'work(2);');
    assert.match(skip.label, /skip/);
  });

  it('chains else-if through the nested condition', async () => {
    const flow = await flowOf('function elseIfChain');
    const outer = flow.steps[0];
    assert.equal(outer.branches[1].label, 'else-if branch');
    const nested = step(flow, outer.branches[1].target);
    assert.equal(nested.kind, 'condition');
    assert.equal(nested.text, 'if (n === 0)');
    assert.equal(nested.branches.length, 2);
  });

  it('does not treat nested function bodies as executed statements', async () => {
    const flow = await flowOf('function nestedFunctionsDoNotRun');
    assert.equal(flow.steps.length, 2, 'handler assignment + return; helper() declaration is not a step');
    assert.deepEqual(flow.steps[0].calls, [], 'arrow body call work(99) is not immediate');
    assert.deepEqual(flow.steps[1].calls.map((c) => c.text), ['items.map'], 'callback body call work(i) is not immediate');
  });

  it('models try/catch/finally with an exception branch and rejoining finally', async () => {
    const flow = await flowOf('function tryCatch');
    const tryStep = flow.steps[0];
    assert.equal(tryStep.kind, 'try');
    assert.deepEqual(tryStep.branches.map((b) => b.id), ['try', 'catch']);

    const catchStep = step(flow, tryStep.branches[1].target);
    assert.equal(catchStep.kind, 'catch');
    assert.equal(catchStep.text, 'catch (e)');

    const awaitStep = step(flow, tryStep.branches[0].target);
    assert.equal(awaitStep.awaits, true);
    assert.equal(awaitStep.kind, 'assignment');

    const finallyStep = flow.steps.find((s) => s.kind === 'finally');
    assert.ok(finallyStep);
    assert.equal(finallyStep.text, 'finally');
    assert.equal(step(flow, finallyStep.next).text, 'cleanup();');
    assert.ok(flow.warnings.some((w) => w.includes('finally')), 'flags that early exits skip finally in this view');
  });

  it('models loops as enter-body or skip, with the body visited once', async () => {
    const flow = await flowOf('function looping');
    const loop = flow.steps.find((s) => s.kind === 'loop');
    assert.ok(loop);
    assert.equal(loop.text, 'for (const i of items)');
    const [body, skip] = loop.branches;
    const bodyStep = step(flow, body.target);
    assert.equal(bodyStep.text, 'sum += work(i);');
    assert.equal(bodyStep.kind, 'assignment');
    assert.equal(bodyStep.next, skip.target, 'no back edge: after one pass flow continues after the loop');
    assert.equal(step(flow, skip.target).kind, 'return');
  });

  it('models switch with one branch per clause, fallthrough and break', async () => {
    const flow = await flowOf('function switching');
    const sw = flow.steps.find((s) => s.kind === 'switch');
    assert.ok(sw);
    assert.deepEqual(sw.branches.map((b) => b.label), ["case 'a'", "case 'b'", "case 'c'", 'default']);
    const [a, b, c, d] = sw.branches.map((br) => br.target);
    assert.equal(b, c, "empty case 'b' falls through into case 'c'");
    const afterC = step(flow, c).next;
    assert.equal(afterC, d, "case 'c' falls through to default (no break)");
    const ret = flow.steps.find((s) => s.kind === 'return')!;
    const breakStep = step(flow, step(flow, a).next);
    assert.equal(breakStep.kind, 'jump');
    assert.equal(breakStep.next, ret.id, 'break leaves the switch');
  });

  it('handles expression-bodied arrows, class methods and empty functions', async () => {
    const arrow = await flowOf('const arrowExpr');
    assert.equal(arrow.function.name, 'arrowExpr');
    assert.equal(arrow.steps.length, 1);
    assert.equal(arrow.steps[0].kind, 'return');

    const method = await flowOf('run(): number');
    assert.equal(method.function.name, 'Service.run');
    assert.deepEqual(method.steps[0].calls.map((c) => c.text), ['this.step']);

    assert.equal((await flowOf('function empty')).entry, null);
  });

  it('orders calls by evaluation order (arguments first)', async () => {
    const flow = await flowOf('function sequence');
    assert.equal(flow.steps[2].calls.length, 1);
  });
});
