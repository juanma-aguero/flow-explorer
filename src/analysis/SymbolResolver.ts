import * as ts from 'typescript';
import type { CallResolution, FunctionRef, UnresolvedReason } from '../flow/FlowTypes';
import { FunctionLike, createFunctionRef, isFunctionLikeWithBody, toLabel, unwrapExpression } from './astUtils';
import type { CallNode } from './StepExtractor';

/**
 * Maps call expressions / identifiers to the function implementations they refer to, using the type checker.
 * It never guesses: anything it cannot prove is returned as `unresolved` with a reason the user can read.
 */
export class SymbolResolver {
  constructor(
    private readonly program: ts.Program,
    private readonly checker: ts.TypeChecker,
  ) {}

  resolveCall(call: CallNode): CallResolution {
    const callee = unwrapExpression(call.expression);
    const label = toLabel(callee.getText(), 60);
    const isNew = ts.isNewExpression(call);

    // Immediately-invoked function expression: the body really does run right here.
    if (isFunctionLikeWithBody(callee)) {
      return { kind: 'resolved', targets: [createFunctionRef(callee, callee.getSourceFile())] };
    }

    if (callee.kind === ts.SyntaxKind.SuperKeyword) {
      return this.resolveSuperCall(call, label);
    }

    if (ts.isPropertyAccessExpression(callee)) return this.resolveNode(callee.name, label, isNew);
    if (ts.isIdentifier(callee)) return this.resolveNode(callee, label, isNew);
    if (ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)) {
      return this.resolveNode(callee.argumentExpression, label, isNew);
    }
    return unresolved('dynamic', `\`${label}\` is computed dynamically, so its target cannot be determined statically.`);
  }

  /** Resolves the symbol under an identifier (used by "Explore Function"). */
  resolveIdentifier(node: ts.Node): CallResolution {
    const label = toLabel(node.getText(), 60);
    // The identifier is the name of a function declaration: that function is the target.
    const owner = this.declarationOwnedByName(node);
    if (owner) return { kind: 'resolved', targets: [createFunctionRef(owner, owner.getSourceFile())] };
    return this.resolveNode(node, label, false);
  }

  private declarationOwnedByName(node: ts.Node): FunctionLike | undefined {
    const parent = node.parent;
    if (!parent) return undefined;
    if (isFunctionLikeWithBody(parent) && (parent as { name?: ts.Node }).name === node) return parent;
    if (
      ts.isVariableDeclaration(parent) &&
      parent.name === node &&
      parent.initializer &&
      isFunctionLikeWithBody(unwrapExpression(parent.initializer))
    ) {
      return unwrapExpression(parent.initializer) as FunctionLike;
    }
    if (
      (ts.isPropertyDeclaration(parent) || ts.isPropertyAssignment(parent)) &&
      parent.name === node &&
      parent.initializer &&
      isFunctionLikeWithBody(unwrapExpression(parent.initializer))
    ) {
      return unwrapExpression(parent.initializer) as FunctionLike;
    }
    return undefined;
  }

  private resolveSuperCall(call: CallNode, label: string): CallResolution {
    let cls: ts.Node | undefined = call.parent;
    while (cls && !ts.isClassLike(cls)) cls = cls.parent;
    const base =
      cls && ts.isClassLike(cls)
        ? cls.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]
        : undefined;
    if (!base) return unresolved('no-symbol', `\`${label}\` has no base class to resolve.`);
    return this.resolveNode(base.expression, label, true);
  }

  private resolveNode(node: ts.Node, label: string, wantConstructor: boolean): CallResolution {
    let symbol = this.checker.getSymbolAtLocation(node);
    if (!symbol) {
      return unresolved('no-symbol', `Could not resolve \`${label}\` to a declaration (no type information for it).`);
    }
    if (symbol.flags & ts.SymbolFlags.Alias) {
      try {
        symbol = this.checker.getAliasedSymbol(symbol);
      } catch {
        return unresolved('no-symbol', `Could not follow the import of \`${label}\`.`);
      }
    }

    const declarations = symbol.declarations ?? [];
    if (declarations.length === 0) {
      return unresolved('no-symbol', `\`${label}\` has no declaration the analyzer can see (is the module installed or resolvable?).`);
    }

    const targets = new Map<string, FunctionRef>();
    let external = 0;
    let bodyless = 0;
    let dynamic = 0;
    let classWithoutCtor = 0;

    for (const decl of declarations) {
      const sf = decl.getSourceFile();
      if (this.isExternal(sf)) {
        external++;
        continue;
      }
      const fn = this.functionOf(decl, wantConstructor);
      if (fn.kind === 'function') {
        const ref = createFunctionRef(fn.node, sf);
        targets.set(ref.id, ref);
      } else if (fn.kind === 'bodyless') bodyless++;
      else if (fn.kind === 'dynamic') dynamic++;
      else if (fn.kind === 'class-without-ctor') classWithoutCtor++;
    }

    if (targets.size > 0) return { kind: 'resolved', targets: [...targets.values()] };

    if (external > 0) {
      return unresolved(
        'external-library',
        `\`${label}\` is defined in a library or declaration file (node_modules / .d.ts). Library code is not explored.`,
      );
    }
    if (classWithoutCtor > 0) {
      return unresolved('no-implementation', `\`${label}\` is a class without an explicit constructor, so there is no constructor body to step into.`);
    }
    if (bodyless > 0) {
      return unresolved(
        'declaration-only',
        `\`${label}\` is only declared here (interface, abstract member or overload signature). The concrete implementation depends on the runtime value, so it is not guessed.`,
      );
    }
    if (dynamic > 0) {
      return unresolved('dynamic', `\`${label}\` is assigned from an expression (not a function literal), so its implementation cannot be determined statically.`);
    }
    return unresolved('not-a-function', `\`${label}\` does not refer to a function with a body.`);
  }

  private isExternal(sf: ts.SourceFile): boolean {
    return sf.isDeclarationFile || this.program.isSourceFileFromExternalLibrary(sf) || /(^|\/)node_modules\//.test(sf.fileName);
  }

  private functionOf(
    decl: ts.Declaration,
    wantConstructor: boolean,
  ): { kind: 'function'; node: FunctionLike } | { kind: 'bodyless' | 'dynamic' | 'class-without-ctor' | 'other' } {
    if (ts.isClassLike(decl)) {
      if (!wantConstructor) return { kind: 'other' };
      const ctor = decl.members.find((m): m is ts.ConstructorDeclaration => ts.isConstructorDeclaration(m) && m.body !== undefined);
      return ctor ? { kind: 'function', node: ctor } : { kind: 'class-without-ctor' };
    }
    if (isFunctionLikeWithBody(decl)) return { kind: 'function', node: decl };
    if (
      ts.isFunctionDeclaration(decl) ||
      ts.isMethodDeclaration(decl) ||
      ts.isMethodSignature(decl) ||
      ts.isConstructorDeclaration(decl) ||
      ts.isCallSignatureDeclaration(decl) ||
      ts.isPropertySignature(decl)
    ) {
      return { kind: 'bodyless' };
    }
    if (ts.isVariableDeclaration(decl) || ts.isPropertyDeclaration(decl) || ts.isPropertyAssignment(decl)) {
      const init = decl.initializer ? unwrapExpression(decl.initializer) : undefined;
      if (init && isFunctionLikeWithBody(init)) return { kind: 'function', node: init };
      if (init && ts.isClassExpression(init) && wantConstructor) return this.functionOf(init, true);
      return init ? { kind: 'dynamic' } : { kind: 'bodyless' };
    }
    if (ts.isExportAssignment(decl)) {
      const expr = unwrapExpression(decl.expression);
      if (isFunctionLikeWithBody(expr)) return { kind: 'function', node: expr };
      return { kind: 'dynamic' };
    }
    return { kind: 'other' };
  }
}

function unresolved(reason: UnresolvedReason, message: string): CallResolution {
  return { kind: 'unresolved', reason, message };
}
