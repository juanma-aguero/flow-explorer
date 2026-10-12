import type { Node } from 'web-tree-sitter';
import type { Branch, CallSite, FlowStep, FunctionFlow, FunctionRef, StepKind } from '../../flow/FlowTypes';
import { LineMap, normalizePath, toLabel } from '../text';
import {
  calleeNameNode,
  collectCalls,
  describeGoFunction,
  allChildren,
  fieldChildren,
  isPanicCall,
  named,
  nonComment,
  statementsOf,
} from './GoSyntax';

export interface GoCallInfo {
  /** The call expression's callee name, as an offset into the file. */
  offset: number;
  /** Set for `func() {...}()`: the literal is its own target. */
  iife?: FunctionRef;
}

export interface GoExtraction {
  flow: FunctionFlow;
  callInfo: Map<string, GoCallInfo>;
}

interface WireContext {
  breakTarget: string | null;
  continueTarget: string | null;
  /** Entry of the next switch clause, for `fallthrough`. */
  fallthroughTarget: string | null;
}

const CLAUSES = new Set(['expression_case', 'default_case', 'type_case', 'communication_case']);

export function createGoFunctionRef(node: Node, file: string, lines: LineMap): FunctionRef {
  const { name, kind, nameNode } = describeGoFunction(node);
  return {
    id: `${file}#${name}@${node.startIndex}`,
    name,
    kind,
    file,
    range: lines.range(file, node.startIndex, node.endIndex),
    nameRange: nameNode ? lines.range(file, nameNode.startIndex, nameNode.endIndex) : undefined,
  };
}

/**
 * Turns one Go function body into the same step graph the TypeScript extractor produces.
 * Go specifics: no implicit switch fallthrough, `defer`/`go` steps, `panic` ends the flow,
 * `if`/`for`/`switch` initializers are part of the header step.
 */
export function extractGoFlow(fn: Node, text: string, file: string, lines: LineMap): GoExtraction {
  return new GoExtractor(fn, text, normalizePath(file), lines).run();
}

class GoExtractor {
  private readonly ref: FunctionRef;
  private readonly steps: FlowStep[] = [];
  private readonly byNode = new Map<number, FlowStep>();
  private readonly callInfo = new Map<string, GoCallInfo>();
  private readonly warnings = new Set<string>();

  constructor(
    private readonly fn: Node,
    private readonly text: string,
    private readonly file: string,
    private readonly lines: LineMap,
  ) {
    this.ref = createGoFunctionRef(fn, file, lines);
  }

  run(): GoExtraction {
    const body = this.fn.childForFieldName('body');
    let entry: string | null = null;
    if (body) {
      const statements = statementsOf(body);
      this.collectAll(statements);
      entry = this.wireAll(statements, null, { breakTarget: null, continueTarget: null, fallthroughTarget: null });
    }
    return {
      flow: {
        function: this.ref,
        steps: this.steps,
        entry,
        source: this.text.slice(this.fn.startIndex, this.fn.endIndex),
        warnings: [...this.warnings],
      },
      callInfo: this.callInfo,
    };
  }

  // -- pass 1: steps in source order ----------------------------------------

  private collectAll(statements: readonly Node[]): void {
    for (const s of statements) this.collect(s);
  }

  private collect(node: Node): void {
    const start = node.startIndex;
    switch (node.type) {
      case 'block':
        this.collectAll(statementsOf(node));
        return;
      case 'short_var_declaration':
      case 'assignment_statement':
      case 'var_declaration':
      case 'const_declaration':
      case 'inc_statement':
      case 'dec_statement':
        this.add(node, 'assignment', start, node.endIndex, [node]);
        return;
      case 'send_statement':
        this.add(node, 'expression', start, node.endIndex, [node]);
        return;
      case 'expression_statement': {
        const calls = collectCalls(node);
        const inner = named(node)[0];
        const panics = inner?.type === 'call_expression' && isPanicCall(inner);
        if (panics) this.warnings.add('`panic` ends the flow here; a deferred function may `recover` it, which this view does not follow.');
        this.add(node, panics ? 'throw' : calls.length > 0 ? 'call' : 'expression', start, node.endIndex, [node]);
        return;
      }
      case 'return_statement':
        this.add(node, 'return', start, node.endIndex, [node]);
        return;
      case 'go_statement':
        this.warnings.add('`go` statements start goroutines that run concurrently; they are shown where they are started.');
        this.add(node, 'go', start, node.endIndex, [node]);
        return;
      case 'defer_statement':
        this.warnings.add('`defer`red calls run when the function returns (last in, first out); they are shown where they are registered.');
        this.add(node, 'defer', start, node.endIndex, [node]);
        return;
      case 'if_statement': {
        const consequence = node.childForFieldName('consequence');
        const alternative = node.childForFieldName('alternative');
        const headerParts = nonComment(node.namedChildren).filter((c) => c.id !== consequence?.id && c.id !== alternative?.id);
        this.add(node, 'condition', start, consequence?.startIndex ?? node.endIndex, headerParts);
        if (consequence) this.collect(consequence);
        if (alternative) this.collect(alternative);
        return;
      }
      case 'for_statement': {
        const body = node.childForFieldName('body');
        const headerParts = nonComment(node.namedChildren).filter((c) => c.id !== body?.id);
        this.add(node, 'loop', start, body?.startIndex ?? node.endIndex, headerParts);
        if (body) this.collect(body);
        return;
      }
      case 'expression_switch_statement':
      case 'type_switch_statement':
      case 'select_statement': {
        const clauses = nonComment(node.namedChildren).filter((c) => CLAUSES.has(c.type));
        const headerParts = nonComment(node.namedChildren).filter((c) => !CLAUSES.has(c.type));
        const brace = allChildren(node).find((c) => c.type === '{');
        this.add(node, 'switch', start, brace?.startIndex ?? node.endIndex, headerParts);
        for (const clause of clauses) this.collectAll(this.clauseStatements(clause));
        return;
      }
      case 'break_statement':
      case 'continue_statement':
      case 'fallthrough_statement':
        if (named(node).some((c) => c.type === 'label_name')) {
          this.warnings.add('Labeled break/continue is approximated by the nearest enclosing loop or switch.');
        }
        this.add(node, 'jump', start, node.endIndex, []);
        return;
      case 'goto_statement':
        this.warnings.add('`goto` is shown as a step but its jump is not followed.');
        this.add(node, 'jump', start, node.endIndex, []);
        return;
      case 'labeled_statement': {
        const inner = nonComment(node.namedChildren).find((c) => c.type !== 'label_name');
        if (inner) this.collect(inner);
        return;
      }
      case 'type_declaration':
      case 'empty_statement':
      case 'comment':
        return;
      default:
        this.add(node, 'other', start, node.endIndex, [node]);
    }
  }

  private clauseStatements(clause: Node): Node[] {
    return statementsOf(clause, ['value', 'type', 'communication']);
  }

  private add(node: Node, kind: StepKind, start: number, end: number, callSources: readonly Node[]): FlowStep {
    const index = this.steps.length;
    const id = `${this.ref.id}/s${index}`;
    // Trim trailing whitespace from header ranges that stop right before a `{`.
    let stop = end;
    while (stop > start && /\s/.test(this.text[stop - 1])) stop--;
    const stepText = this.text.slice(start, stop);

    const calls: CallSite[] = [];
    for (const source of callSources) {
      for (const call of collectCalls(source)) calls.push(this.toCallSite(`${id}/c${calls.length}`, call));
    }

    const step: FlowStep = {
      id,
      index,
      kind,
      label: toLabel(stepText),
      text: stepText,
      range: this.lines.range(this.file, start, stop),
      awaits: false,
      calls,
      next: null,
      branches: [],
    };
    this.steps.push(step);
    this.byNode.set(node.id, step);
    return step;
  }

  private toCallSite(id: string, call: Node): CallSite {
    const callee = call.childForFieldName('function');
    const nameNode = calleeNameNode(call) ?? call;
    const info: GoCallInfo = { offset: nameNode.startIndex };
    if (callee?.type === 'func_literal' && callee.childForFieldName('body')) {
      info.iife = createGoFunctionRef(callee, this.file, this.lines);
    }
    this.callInfo.set(id, info);
    return {
      id,
      text: toLabel(callee?.text ?? call.text, 60),
      isNew: false,
      awaited: false,
      calleeRange: this.lines.range(this.file, nameNode.startIndex, nameNode.endIndex),
    };
  }

  // -- pass 2: wiring ----------------------------------------------------------

  private wireAll(statements: readonly Node[], cont: string | null, ctx: WireContext): string | null {
    let entry = cont;
    for (let i = statements.length - 1; i >= 0; i--) entry = this.wire(statements[i], entry, ctx);
    return entry;
  }

  private wire(node: Node, cont: string | null, ctx: WireContext): string | null {
    if (node.type === 'block') return this.wireAll(statementsOf(node), cont, ctx);
    if (node.type === 'labeled_statement') {
      const inner = nonComment(node.namedChildren).find((c) => c.type !== 'label_name');
      return inner ? this.wire(inner, cont, ctx) : cont;
    }

    const step = this.byNode.get(node.id);
    if (!step) return cont;

    switch (node.type) {
      case 'return_statement':
      case 'goto_statement':
        step.next = null;
        break;
      case 'expression_statement':
        step.next = step.kind === 'throw' ? null : cont;
        break;
      case 'break_statement':
        step.next = ctx.breakTarget;
        break;
      case 'continue_statement':
        step.next = ctx.continueTarget;
        break;
      case 'fallthrough_statement':
        step.next = ctx.fallthroughTarget;
        break;
      case 'if_statement':
        this.wireIf(node, step, cont, ctx);
        break;
      case 'for_statement': {
        const body = node.childForFieldName('body');
        const bodyEntry = body ? this.wire(body, cont, { ...ctx, breakTarget: cont, continueTarget: cont }) : cont;
        const infinite = nonComment(node.namedChildren).every((c) => c.id === body?.id);
        step.branches = [
          { id: 'body', label: 'enter loop body (one pass)', target: bodyEntry },
          { id: 'skip', label: infinite ? 'leave loop (via break)' : 'skip loop (zero iterations / after loop)', target: cont },
        ];
        break;
      }
      case 'expression_switch_statement':
      case 'type_switch_statement':
      case 'select_statement':
        this.wireSwitch(node, step, cont, ctx);
        break;
      default:
        step.next = cont;
    }
    return step.id;
  }

  private wireIf(node: Node, step: FlowStep, cont: string | null, ctx: WireContext): void {
    const consequence = node.childForFieldName('consequence');
    const alternative = node.childForFieldName('alternative');
    const thenEntry = consequence ? this.wire(consequence, cont, ctx) : cont;
    const elseEntry = alternative ? this.wire(alternative, cont, ctx) : cont;
    const cond = toLabel(node.childForFieldName('condition')?.text ?? '', 70);
    step.branches = [
      { id: 'then', label: `if branch — when \`${cond}\` holds`, target: thenEntry },
      {
        id: 'else',
        label: alternative ? (alternative.type === 'if_statement' ? 'else-if branch' : 'else branch') : `skip — when \`${cond}\` does not hold`,
        target: elseEntry,
      },
    ];
  }

  private wireSwitch(node: Node, step: FlowStep, cont: string | null, ctx: WireContext): void {
    const clauses = nonComment(node.namedChildren).filter((c) => CLAUSES.has(c.type));
    const entries: (string | null)[] = new Array(clauses.length).fill(null);
    // Go has no implicit fallthrough: a clause continues after the switch unless it says `fallthrough`.
    let nextEntry = cont;
    for (let i = clauses.length - 1; i >= 0; i--) {
      entries[i] = this.wireAll(this.clauseStatements(clauses[i]), cont, { ...ctx, breakTarget: cont, fallthroughTarget: nextEntry });
      nextEntry = entries[i];
    }
    const branches: Branch[] = clauses.map((clause, i) => ({
      id: `case${i}`,
      label: this.clauseLabel(clause),
      target: entries[i],
    }));
    const hasDefault = clauses.some((c) => c.type === 'default_case');
    if (!hasDefault && node.type !== 'select_statement') branches.push({ id: 'none', label: 'no case matches', target: cont });
    step.branches = branches;
  }

  private clauseLabel(clause: Node): string {
    switch (clause.type) {
      case 'default_case':
        return 'default';
      case 'expression_case':
        return `case ${toLabel(clause.childForFieldName('value')?.text ?? '', 60)}`;
      case 'type_case':
        return `case ${toLabel(fieldChildren(clause, 'type').filter((t) => t.isNamed).map((t) => t.text).join(', '), 60)}`;
      default:
        return `case ${toLabel(clause.childForFieldName('communication')?.text ?? '', 60)}`;
    }
  }
}
