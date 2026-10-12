import * as ts from 'typescript';
import type { Branch, CallSite, FlowStep, FunctionFlow, FunctionRef, StepKind } from '../flow/FlowTypes';
import {
  FunctionLike,
  createFunctionRef,
  isDeferredBodyNode,
  nodeRange,
  toLabel,
  toRange,
  unwrapExpression,
} from './astUtils';

export type CallNode = ts.CallExpression | ts.NewExpression;

export interface ExtractionResult {
  flow: FunctionFlow;
  /** AST nodes behind each `CallSite.id`, so the resolver can ask the type checker about them. */
  callNodes: Map<string, CallNode>;
}

interface WireContext {
  /** Where `break` goes. */
  breakTarget: string | null;
  /** Where `continue` goes (loops are modelled as a single pass, so this is the loop continuation). */
  continueTarget: string | null;
  /** The catch step that a `throw` inside the current try block reaches, if any. */
  catchTarget: string | null;
}

/**
 * Turns one function body into a graph of {@link FlowStep}s.
 *
 * The result is a *logical* flow, not an execution trace:
 *  - statements become steps in source order,
 *  - `if`/`switch`/loops/`try` become steps with several {@link Branch}es, because the path depends on runtime values,
 *  - loop bodies are visited once (no back edge),
 *  - nested functions and classes are never part of the enclosing function's steps.
 */
export function extractFlow(fn: FunctionLike, sf: ts.SourceFile): ExtractionResult {
  return new Extractor(fn, sf).run();
}

class Extractor {
  private readonly ref: FunctionRef;
  private readonly steps: FlowStep[] = [];
  private readonly byNode = new Map<ts.Node, FlowStep>();
  private readonly callNodes = new Map<string, CallNode>();
  private readonly warnings = new Set<string>();

  constructor(
    private readonly fn: FunctionLike,
    private readonly sf: ts.SourceFile,
  ) {
    this.ref = createFunctionRef(fn, sf);
  }

  run(): ExtractionResult {
    const body = this.fn.body;
    let entry: string | null = null;

    if (body && ts.isBlock(body)) {
      this.collectStatements(body.statements);
      entry = this.wireStatements(body.statements, null, { breakTarget: null, continueTarget: null, catchTarget: null });
    } else if (body) {
      // Expression-bodied arrow function: a single implicit return.
      const step = this.createStep(body, 'return', body.getStart(this.sf), body.getEnd(), [body]);
      step.next = null;
      entry = step.id;
    }

    return {
      flow: {
        function: this.ref,
        steps: this.steps,
        entry,
        source: this.fn.getText(this.sf),
        warnings: [...this.warnings],
      },
      callNodes: this.callNodes,
    };
  }

  // ---------------------------------------------------------------------------
  // Pass 1: create steps in source order
  // ---------------------------------------------------------------------------

  private collectStatements(statements: readonly ts.Statement[]): void {
    for (const statement of statements) this.collect(statement);
  }

  private collect(node: ts.Statement): void {
    const sf = this.sf;
    const start = node.getStart(sf);

    if (ts.isBlock(node)) {
      this.collectStatements(node.statements);
    } else if (ts.isVariableStatement(node)) {
      const step = this.createStep(node, 'assignment', start, node.getEnd(), [node.declarationList]);
      this.byNode.set(node, step);
    } else if (ts.isExpressionStatement(node)) {
      const step = this.createStep(node, this.expressionKind(node.expression), start, node.getEnd(), [node.expression]);
      this.byNode.set(node, step);
    } else if (ts.isReturnStatement(node)) {
      this.byNode.set(node, this.createStep(node, 'return', start, node.getEnd(), [node.expression]));
    } else if (ts.isThrowStatement(node)) {
      this.byNode.set(node, this.createStep(node, 'throw', start, node.getEnd(), [node.expression]));
    } else if (ts.isIfStatement(node)) {
      const end = this.headerEnd(node);
      this.byNode.set(node, this.createStep(node, 'condition', start, end, [node.expression]));
      this.collect(node.thenStatement);
      if (node.elseStatement) this.collect(node.elseStatement);
    } else if (ts.isForStatement(node)) {
      const end = this.headerEnd(node);
      const parts = [node.initializer, node.condition, node.incrementor];
      this.byNode.set(node, this.createStep(node, 'loop', start, end, parts));
      this.collect(node.statement);
    } else if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
      const end = this.headerEnd(node);
      const awaits = ts.isForOfStatement(node) && node.awaitModifier !== undefined;
      this.byNode.set(node, this.createStep(node, 'loop', start, end, [node.expression], awaits));
      this.collect(node.statement);
    } else if (ts.isWhileStatement(node)) {
      this.byNode.set(node, this.createStep(node, 'loop', start, this.headerEnd(node), [node.expression]));
      this.collect(node.statement);
    } else if (ts.isDoStatement(node)) {
      // Only the `do` keyword is the loop step; calls in the trailing `while (...)` condition are not modelled.
      this.byNode.set(node, this.createStep(node, 'loop', start, start + 2, []));
      this.collect(node.statement);
    } else if (ts.isSwitchStatement(node)) {
      this.byNode.set(node, this.createStep(node, 'switch', start, this.headerEnd(node), [node.expression]));
      for (const clause of node.caseBlock.clauses) this.collectStatements(clause.statements);
    } else if (ts.isTryStatement(node)) {
      const tryKeyword = node.getChildren(sf)[0];
      this.byNode.set(node, this.createStep(node, 'try', start, tryKeyword.getEnd(), []));
      this.collectStatements(node.tryBlock.statements);
      if (node.catchClause) {
        const clause = node.catchClause;
        const children = clause.getChildren(sf);
        const headerEnd = children[children.length - 2]?.getEnd() ?? clause.getStart(sf) + 'catch'.length;
        this.byNode.set(clause, this.createStep(clause, 'catch', clause.getStart(sf), headerEnd, []));
        this.collectStatements(clause.block.statements);
      }
      if (node.finallyBlock) {
        const keyword = node.getChildren(sf).find((c) => c.kind === ts.SyntaxKind.FinallyKeyword);
        const kStart = keyword ? keyword.getStart(sf) : node.finallyBlock.getStart(sf);
        const kEnd = keyword ? keyword.getEnd() : kStart + 'finally'.length;
        this.byNode.set(node.finallyBlock, this.createStep(node.finallyBlock, 'finally', kStart, kEnd, []));
        this.collectStatements(node.finallyBlock.statements);
        if (this.containsExit(node.tryBlock) || (node.catchClause && this.containsExit(node.catchClause.block))) {
          this.warnings.add('`finally` blocks are only reached by falling out of try/catch; early return/throw skips them in this view.');
        }
      }
    } else if (ts.isBreakStatement(node) || ts.isContinueStatement(node)) {
      if (node.label) this.warnings.add('Labeled break/continue is approximated by the nearest enclosing loop or switch.');
      this.byNode.set(node, this.createStep(node, 'jump', start, node.getEnd(), []));
    } else if (ts.isLabeledStatement(node)) {
      this.collect(node.statement);
    } else if (
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isModuleDeclaration(node) ||
      ts.isEmptyStatement(node) ||
      ts.isImportDeclaration(node) ||
      ts.isImportEqualsDeclaration(node) ||
      ts.isExportDeclaration(node) ||
      ts.isDebuggerStatement(node)
    ) {
      // Declarations are hoisted/type-only: they are not executed as part of this function's flow.
    } else {
      this.byNode.set(node, this.createStep(node, 'other', start, node.getEnd(), [node]));
    }
  }

  private expressionKind(expr: ts.Expression): StepKind {
    const inner = unwrapExpression(expr);
    const target = ts.isAwaitExpression(inner) ? unwrapExpression(inner.expression) : inner;
    if (
      ts.isBinaryExpression(target) &&
      target.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      target.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      return 'assignment';
    }
    return this.collectCalls(expr).calls.length > 0 ? 'call' : 'expression';
  }

  /** End of `if (...)`, `while (...)`, `for (...)`, `switch (...)`: the header, not the whole body. */
  private headerEnd(node: ts.Node): number {
    const close = node.getChildren(this.sf).find((c) => c.kind === ts.SyntaxKind.CloseParenToken);
    return close ? close.getEnd() : node.getEnd();
  }

  private containsExit(node: ts.Node): boolean {
    let found = false;
    const visit = (n: ts.Node): void => {
      if (found || isDeferredBodyNode(n)) return;
      if (ts.isReturnStatement(n) || ts.isThrowStatement(n)) {
        found = true;
        return;
      }
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(node, visit);
    return found;
  }

  private createStep(
    _node: ts.Node,
    kind: StepKind,
    start: number,
    end: number,
    callSources: ReadonlyArray<ts.Node | undefined>,
    forceAwait = false,
  ): FlowStep {
    const index = this.steps.length;
    const id = `${this.ref.id}/s${index}`;
    let awaits = forceAwait;
    const callExprs: CallNode[] = [];
    for (const source of callSources) {
      if (!source) continue;
      const found = this.collectCalls(source);
      awaits = awaits || found.awaits;
      callExprs.push(...found.calls);
    }
    const calls = callExprs.map((call, i) => this.toCallSite(`${id}/c${i}`, call));
    const text = this.sf.text.slice(start, end);
    const step: FlowStep = {
      id,
      index,
      kind,
      label: toLabel(text),
      text,
      range: toRange(this.sf, start, end),
      awaits,
      calls,
      next: null,
      branches: [],
    };
    this.steps.push(step);
    return step;
  }

  private toCallSite(id: string, call: CallNode): CallSite {
    this.callNodes.set(id, call);
    const callee = unwrapExpression(call.expression);
    let nameNode: ts.Node = callee;
    if (ts.isPropertyAccessExpression(callee)) nameNode = callee.name;
    else if (ts.isElementAccessExpression(callee)) nameNode = callee.argumentExpression;
    return {
      id,
      text: toLabel(callee.getText(this.sf), 60),
      isNew: ts.isNewExpression(call),
      awaited: this.isAwaited(call),
      calleeRange: nodeRange(this.sf, nameNode),
    };
  }

  private isAwaited(call: ts.Node): boolean {
    let parent = call.parent;
    while (parent && (ts.isParenthesizedExpression(parent) || ts.isNonNullExpression(parent) || ts.isAsExpression(parent))) {
      parent = parent.parent;
    }
    return parent !== undefined && ts.isAwaitExpression(parent);
  }

  /**
   * Calls that run when the node is evaluated, in evaluation order (arguments before the call itself).
   * Does not descend into nested functions/classes: their bodies do not run now.
   */
  private collectCalls(root: ts.Node): { calls: CallNode[]; awaits: boolean } {
    const calls: CallNode[] = [];
    let awaits = false;
    const visit = (node: ts.Node): void => {
      if (isDeferredBodyNode(node)) return;
      if (ts.isAwaitExpression(node)) awaits = true;
      ts.forEachChild(node, visit);
      if (ts.isCallExpression(node) && node.expression.kind !== ts.SyntaxKind.ImportKeyword) calls.push(node);
      else if (ts.isNewExpression(node)) calls.push(node);
    };
    if (isDeferredBodyNode(root)) return { calls, awaits };
    visit(root);
    return { calls, awaits };
  }

  // ---------------------------------------------------------------------------
  // Pass 2: wire `next` pointers and branches
  // ---------------------------------------------------------------------------

  /** Wires a statement list whose continuation is `cont`; returns the entry step id (or `cont` if empty). */
  private wireStatements(statements: readonly ts.Statement[], cont: string | null, ctx: WireContext): string | null {
    let entry = cont;
    for (let i = statements.length - 1; i >= 0; i--) {
      entry = this.wire(statements[i], entry, ctx);
    }
    return entry;
  }

  private wire(node: ts.Statement, cont: string | null, ctx: WireContext): string | null {
    if (ts.isBlock(node)) return this.wireStatements(node.statements, cont, ctx);
    if (ts.isLabeledStatement(node)) return this.wire(node.statement, cont, ctx);

    const step = this.byNode.get(node);
    if (!step) return cont; // hoisted declarations etc.

    if (ts.isReturnStatement(node)) {
      step.next = null;
    } else if (ts.isThrowStatement(node)) {
      step.next = ctx.catchTarget;
    } else if (ts.isBreakStatement(node)) {
      step.next = ctx.breakTarget;
    } else if (ts.isContinueStatement(node)) {
      step.next = ctx.continueTarget;
    } else if (ts.isIfStatement(node)) {
      const thenEntry = this.wire(node.thenStatement, cont, ctx);
      const elseEntry = node.elseStatement ? this.wire(node.elseStatement, cont, ctx) : cont;
      const cond = toLabel(node.expression.getText(this.sf), 70);
      step.branches = [
        { id: 'then', label: `if branch — when \`${cond}\` holds`, target: thenEntry },
        {
          id: 'else',
          label: node.elseStatement
            ? ts.isIfStatement(node.elseStatement)
              ? 'else-if branch'
              : 'else branch'
            : `skip — when \`${cond}\` does not hold`,
          target: elseEntry,
        },
      ];
    } else if (
      ts.isForStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node)
    ) {
      const bodyEntry = this.wire(node.statement, cont, { ...ctx, breakTarget: cont, continueTarget: cont });
      step.branches = [
        { id: 'body', label: 'enter loop body (one pass)', target: bodyEntry },
        { id: 'skip', label: 'skip loop (zero iterations / after loop)', target: cont },
      ];
    } else if (ts.isSwitchStatement(node)) {
      this.wireSwitch(node, step, cont, ctx);
    } else if (ts.isTryStatement(node)) {
      this.wireTry(node, step, cont, ctx);
    } else {
      step.next = cont;
    }
    return step.id;
  }

  private wireSwitch(node: ts.SwitchStatement, step: FlowStep, cont: string | null, ctx: WireContext): void {
    const inner: WireContext = { ...ctx, breakTarget: cont };
    const clauses = node.caseBlock.clauses;
    const entries: (string | null)[] = new Array(clauses.length);
    // Build back to front so each clause can fall through into the next one.
    let fallthrough = cont;
    for (let i = clauses.length - 1; i >= 0; i--) {
      entries[i] = this.wireStatements(clauses[i].statements, fallthrough, inner);
      fallthrough = entries[i];
    }
    const branches: Branch[] = clauses.map((clause, i) => ({
      id: `case${i}`,
      label: ts.isDefaultClause(clause) ? 'default' : `case ${toLabel(clause.expression.getText(this.sf), 60)}`,
      target: entries[i],
    }));
    if (!clauses.some((c) => ts.isDefaultClause(c))) {
      branches.push({ id: 'none', label: 'no case matches', target: cont });
    }
    step.branches = branches;
  }

  private wireTry(node: ts.TryStatement, step: FlowStep, cont: string | null, ctx: WireContext): void {
    const finallyStep = node.finallyBlock ? this.byNode.get(node.finallyBlock) : undefined;
    let afterTry = cont;
    if (node.finallyBlock && finallyStep) {
      finallyStep.next = this.wireStatements(node.finallyBlock.statements, cont, ctx);
      afterTry = finallyStep.id;
    }

    const catchStep = node.catchClause ? this.byNode.get(node.catchClause) : undefined;
    if (node.catchClause && catchStep) {
      catchStep.next = this.wireStatements(node.catchClause.block.statements, afterTry, ctx);
    }

    const tryEntry = this.wireStatements(node.tryBlock.statements, afterTry, {
      ...ctx,
      catchTarget: catchStep ? catchStep.id : ctx.catchTarget,
    });

    if (catchStep) {
      step.branches = [
        { id: 'try', label: 'try block runs without throwing', target: tryEntry },
        { id: 'catch', label: 'an exception is thrown — catch handler', target: catchStep.id },
      ];
    } else {
      step.next = tryEntry;
    }
  }
}
