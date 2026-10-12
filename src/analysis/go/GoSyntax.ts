import { Language, Parser, type Node } from 'web-tree-sitter';
import type { FunctionKind } from '../../flow/FlowTypes';

export type { Node as SyntaxNode };

export interface GrammarPaths {
  /** Path to web-tree-sitter's `tree-sitter.wasm` runtime. */
  runtimeWasm: string;
  /** Path to the compiled Go grammar (`tree-sitter-go.wasm`). */
  grammarWasm: string;
}

let runtimeReady: Promise<void> | undefined;
let goLanguage: Promise<Language> | undefined;

/** Creates a Go parser. The WASM runtime and grammar are loaded once per process. */
export async function createGoParser(paths: GrammarPaths): Promise<Parser> {
  runtimeReady ??= Parser.init({ locateFile: (name: string) => (name.endsWith('tree-sitter.wasm') ? paths.runtimeWasm : name) });
  await runtimeReady;
  goLanguage ??= Language.load(paths.grammarWasm);
  const parser = new Parser();
  parser.setLanguage(await goLanguage);
  return parser;
}

const present = (nodes: readonly (Node | null)[]): Node[] => nodes.filter((n): n is Node => n !== null);

/** Named children without nulls. */
export const named = (node: Node | null | undefined): Node[] => (node ? present(node.namedChildren) : []);
/** All children (including tokens like `{`) without nulls. */
export const allChildren = (node: Node): Node[] => present(node.children);
/** Children assigned to a grammar field (a field can repeat, e.g. `var a, b = ...`). */
export const fieldChildren = (node: Node, field: string): Node[] => present(node.childrenForFieldName(field));

const FUNCTION_TYPES = new Set(['function_declaration', 'method_declaration', 'func_literal']);

/** Function-like node that has a body we can step through. */
export function isGoFunction(node: Node): boolean {
  return FUNCTION_TYPES.has(node.type) && node.childForFieldName('body') !== null;
}

export function nonComment(nodes: readonly (Node | null)[]): Node[] {
  return present(nodes).filter((n) => n.type !== 'comment');
}

/** Executable statements of a block-like node (block, or the body of a case clause). */
export function statementsOf(node: Node, excludeFields: readonly string[] = []): Node[] {
  const skip = new Set<number>();
  for (const field of excludeFields) for (const child of fieldChildren(node, field)) skip.add(child.id);
  return nonComment(node.namedChildren).filter((c) => !skip.has(c.id));
}

/** Walks up from a node to the innermost enclosing function with a body. */
export function enclosingFunction(node: Node | null): Node | null {
  for (let n = node; n; n = n.parent) if (isGoFunction(n)) return n;
  return null;
}

export interface GoFunctionName {
  name: string;
  kind: FunctionKind;
  nameNode: Node | null;
}

export function describeGoFunction(node: Node): GoFunctionName {
  if (node.type === 'function_declaration') {
    const nameNode = node.childForFieldName('name');
    return { name: nameNode?.text ?? '<anonymous>', kind: 'function', nameNode };
  }
  if (node.type === 'method_declaration') {
    const nameNode = node.childForFieldName('name');
    const receiver = named(node.childForFieldName('receiver')).find((c) => c.type === 'parameter_declaration');
    const recvType = (receiver?.childForFieldName('type')?.text ?? '').replace(/^\*/, '').replace(/\[.*\]$/, '');
    return { name: recvType ? `${recvType}.${nameNode?.text ?? ''}` : nameNode?.text ?? '<anonymous>', kind: 'method', nameNode };
  }
  const assigned = assignedName(node);
  return { name: assigned?.text ?? '<anonymous>', kind: 'function-expression', nameNode: assigned };
}

/** For `x := func() {...}`, `x = func() {...}` and `var x = func() {...}`: the identifier `x`. */
export function assignedName(literal: Node): Node | null {
  const list = literal.parent;
  if (!list || list.type !== 'expression_list') return null;
  const index = named(list).findIndex((c) => c.id === literal.id);
  const owner = list.parent;
  if (!owner || index < 0) return null;
  if (owner.type === 'short_var_declaration' || owner.type === 'assignment_statement') {
    const left = named(owner.childForFieldName('left'))[index];
    return left && left.type === 'identifier' ? left : null;
  }
  if (owner.type === 'var_spec') {
    return fieldChildren(owner, 'name')[index] ?? null;
  }
  return null;
}

/** If `identifier` is the name an assigned function literal is bound to, returns that literal. */
export function literalNamedBy(identifier: Node): Node | null {
  const list = identifier.parent;
  if (!list) return null;
  if (list.type === 'var_spec') {
    const index = fieldChildren(list, 'name').findIndex((c) => c.id === identifier.id);
    const value = named(list.childForFieldName('value'))[index];
    return value && value.type === 'func_literal' && isGoFunction(value) ? value : null;
  }
  if (list.type !== 'expression_list') return null;
  const owner = list.parent;
  if (!owner || (owner.type !== 'short_var_declaration' && owner.type !== 'assignment_statement')) return null;
  const left = owner.childForFieldName('left');
  if (!left || left.id !== list.id) return null;
  const index = named(list).findIndex((c) => c.id === identifier.id);
  const value = named(owner.childForFieldName('right'))[index];
  return value && value.type === 'func_literal' && isGoFunction(value) ? value : null;
}

const BUILTIN_FUNCTIONS = new Set([
  'append', 'cap', 'clear', 'close', 'complex', 'copy', 'delete', 'imag', 'len', 'make', 'max', 'min', 'new',
  'panic', 'print', 'println', 'real', 'recover',
]);
const PREDECLARED_TYPES = new Set([
  'any', 'bool', 'byte', 'comparable', 'complex64', 'complex128', 'error', 'float32', 'float64', 'int', 'int8', 'int16',
  'int32', 'int64', 'rune', 'string', 'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr',
]);

/** Calls that are not user-defined functions: builtins, predeclared-type conversions, `(*T)(x)` conversions. */
export function isBuiltinOrConversion(call: Node): boolean {
  const fn = call.childForFieldName('function');
  if (!fn) return false;
  if (fn.type === 'identifier') return BUILTIN_FUNCTIONS.has(fn.text) || PREDECLARED_TYPES.has(fn.text);
  if (fn.type === 'parenthesized_expression') {
    const inner = named(fn)[0];
    return inner?.type === 'unary_expression' && inner.text.startsWith('*');
  }
  return false;
}

/** `panic(...)` as a statement. */
export function isPanicCall(call: Node): boolean {
  const fn = call.childForFieldName('function');
  return fn?.type === 'identifier' && fn.text === 'panic';
}

/**
 * Calls evaluated when `root` is evaluated, in evaluation order (arguments before the call itself).
 * Does not descend into function literals: their bodies do not run now.
 */
export function collectCalls(root: Node): Node[] {
  const calls: Node[] = [];
  const visit = (node: Node): void => {
    if (node.type === 'func_literal') return;
    for (const child of named(node)) visit(child);
    if (node.type === 'call_expression' && !isBuiltinOrConversion(node)) calls.push(node);
  };
  if (root.type !== 'func_literal') visit(root);
  return calls;
}

/** The identifier to hand to the definition provider for a call, and a display label. */
export function calleeNameNode(call: Node): Node | null {
  let fn = call.childForFieldName('function');
  while (fn && fn.type === 'parenthesized_expression') fn = named(fn)[0] ?? null;
  if (!fn) return null;
  if (fn.type === 'selector_expression') return fn.childForFieldName('field') ?? fn;
  return fn;
}
