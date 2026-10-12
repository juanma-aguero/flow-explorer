import * as ts from 'typescript';
import type { FunctionKind, FunctionRef, SourcePosition, SourceRange } from '../flow/FlowTypes';
import { normalizePath, toLabel } from './text';

export type FunctionLike =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.ArrowFunction
  | ts.FunctionExpression
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

export { normalizePath, toLabel };

/** True for function-like nodes that have a body we can step through. */
export function isFunctionLikeWithBody(node: ts.Node): node is FunctionLike {
  return (
    (ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)) &&
    node.body !== undefined
  );
}

/** Any node that introduces a new function scope whose body does not run when it is merely evaluated. */
export function isDeferredBodyNode(node: ts.Node): boolean {
  return (
    ts.isFunctionLike(node) ||
    ts.isClassLike(node) ||
    ts.isModuleDeclaration(node)
  );
}

export function toPosition(sf: ts.SourceFile, offset: number): SourcePosition {
  const { line, character } = sf.getLineAndCharacterOfPosition(offset);
  return { line, character, offset };
}

export function toRange(sf: ts.SourceFile, start: number, end: number): SourceRange {
  return { file: normalizePath(sf.fileName), start: toPosition(sf, start), end: toPosition(sf, end) };
}

export function nodeRange(sf: ts.SourceFile, node: ts.Node): SourceRange {
  return toRange(sf, node.getStart(sf), node.getEnd());
}

export function unwrapExpression(expr: ts.Expression): ts.Expression {
  let current = expr;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression;
    } else {
      return current;
    }
  }
}

function propertyNameText(name: ts.PropertyName | ts.BindingName | undefined, sf: ts.SourceFile): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return name.getText(sf);
}

function className(cls: ts.Node): string {
  if ((ts.isClassDeclaration(cls) || ts.isClassExpression(cls)) && cls.name) return cls.name.text;
  if (ts.isClassExpression(cls) && ts.isVariableDeclaration(cls.parent) && ts.isIdentifier(cls.parent.name)) {
    return cls.parent.name.text;
  }
  return '<anonymous class>';
}

interface NameInfo {
  name: string;
  kind: FunctionKind;
  nameNode?: ts.Node;
}

export function describeFunction(node: FunctionLike, sf: ts.SourceFile): NameInfo {
  if (ts.isFunctionDeclaration(node)) {
    return { name: node.name?.text ?? 'default', kind: 'function', nameNode: node.name };
  }
  if (ts.isConstructorDeclaration(node)) {
    return { name: `${className(node.parent)}.constructor`, kind: 'constructor' };
  }
  if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    const member = propertyNameText(node.name, sf) ?? '<anonymous>';
    const kind: FunctionKind = ts.isMethodDeclaration(node) ? 'method' : 'accessor';
    if (ts.isClassLike(node.parent)) {
      return { name: `${className(node.parent)}.${member}`, kind, nameNode: node.name };
    }
    return { name: member, kind, nameNode: node.name };
  }
  // Arrow functions and function expressions are named after what they are assigned to.
  const kind: FunctionKind = ts.isArrowFunction(node) ? 'arrow' : 'function-expression';
  if (ts.isFunctionExpression(node) && node.name) {
    return { name: node.name.text, kind, nameNode: node.name };
  }
  let parent: ts.Node = node.parent;
  while (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isSatisfiesExpression(parent)) {
    parent = parent.parent;
  }
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return { name: parent.name.text, kind, nameNode: parent.name };
  }
  if (ts.isPropertyDeclaration(parent) && ts.isClassLike(parent.parent)) {
    const member = propertyNameText(parent.name, sf) ?? '<anonymous>';
    return { name: `${className(parent.parent)}.${member}`, kind, nameNode: parent.name };
  }
  if (ts.isPropertyAssignment(parent)) {
    return { name: propertyNameText(parent.name, sf) ?? '<anonymous>', kind, nameNode: parent.name };
  }
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return { name: parent.left.getText(sf), kind };
  }
  if (ts.isExportAssignment(parent)) {
    return { name: 'default', kind };
  }
  return { name: '<anonymous>', kind };
}

export function createFunctionRef(node: FunctionLike, sf: ts.SourceFile): FunctionRef {
  const { name, kind, nameNode } = describeFunction(node, sf);
  const file = normalizePath(sf.fileName);
  const start = node.getStart(sf);
  return {
    id: `${file}#${name}@${start}`,
    name,
    kind,
    file,
    range: toRange(sf, start, node.getEnd()),
    nameRange: nameNode ? nodeRange(sf, nameNode) : undefined,
  };
}

/** Innermost node whose [start, end] contains the offset. */
export function findInnermostNode(sf: ts.SourceFile, offset: number): ts.Node {
  let found: ts.Node = sf;
  const visit = (node: ts.Node): void => {
    if (offset >= node.getStart(sf) && offset <= node.getEnd()) {
      found = node;
      ts.forEachChild(node, visit);
    }
  };
  ts.forEachChild(sf, visit);
  return found;
}
