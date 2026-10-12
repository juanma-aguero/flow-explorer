import { execFile } from 'child_process';
import * as fs from 'fs';
import type { Parser, Tree } from 'web-tree-sitter';
import type { CallResolution, CallSite, FunctionFlow, FunctionRef, UnresolvedReason } from '../../flow/FlowTypes';
import type { CodeAnalyzer } from '../CodeAnalyzer';
import { LineMap, normalizePath, toLabel } from '../text';
import type { DefinitionLocation, DefinitionLookup } from './DefinitionLookup';
import { GoCallInfo, createGoFunctionRef, extractGoFlow } from './GoStepExtractor';
import {
  GrammarPaths,
  SyntaxNode,
  createGoParser,
  isGoFunction,
  literalNamedBy,
} from './GoSyntax';

export interface GoAnalyzerOptions extends GrammarPaths {
  lookup: DefinitionLookup;
  /** Unsaved editor text, so analysis matches what the user sees. */
  readOverlay?: (file: string) => string | undefined;
  /** GOROOT, to recognise the standard library. Detected with `go env GOROOT` when omitted. */
  goroot?: string;
}

interface ParsedFile {
  text: string;
  tree: Tree;
  lines: LineMap;
}

type Classified =
  | { kind: 'function'; ref: FunctionRef }
  | { kind: 'external' | 'bodyless' | 'dynamic' | 'not-a-function' };

/**
 * Go support: structure (steps, branches, calls) comes from the tree-sitter Go grammar; *meaning* (which function a
 * call refers to) comes from the language server through a {@link DefinitionLookup}. Nothing is guessed: when
 * the server cannot say, the call is reported as unresolved with a reason.
 */
export class GoAnalyzer implements CodeAnalyzer {
  private readonly parsed = new Map<string, ParsedFile>();
  private readonly flows = new Map<string, FunctionFlow>();
  private readonly callInfo = new Map<string, GoCallInfo & { file: string }>();
  private readonly resolutions = new Map<string, Promise<CallResolution>>();
  private gorootPromise: Promise<string | undefined> | undefined;

  private constructor(
    private readonly parser: Parser,
    private readonly options: GoAnalyzerOptions,
  ) {}

  static async create(options: GoAnalyzerOptions): Promise<GoAnalyzer> {
    return new GoAnalyzer(await createGoParser(options), options);
  }

  async findFunctionAt(file: string, offset: number): Promise<FunctionRef | undefined> {
    const parsed = this.parse(file);
    if (!parsed) return undefined;
    const node = parsed.tree.rootNode.descendantForIndex(offset);

    // Cursor on `x` in `x := func() {...}` selects that function.
    if (node && (node.type === 'identifier' || node.type === 'field_identifier')) {
      const literal = literalNamedBy(node);
      if (literal) return createGoFunctionRef(literal, normalizePath(file), parsed.lines);
    }
    for (let n: SyntaxNode | null = node; n; n = n.parent) {
      if (isGoFunction(n)) return createGoFunctionRef(n, normalizePath(file), parsed.lines);
    }
    return undefined;
  }

  async resolveSymbolAt(file: string, offset: number): Promise<CallResolution | undefined> {
    const parsed = this.parse(file);
    if (!parsed) return undefined;
    const node = parsed.tree.rootNode.descendantForIndex(offset);
    if (!node || (node.type !== 'identifier' && node.type !== 'field_identifier')) return undefined;

    // The name of a function/method declaration (or of a variable bound to a literal) is its own target.
    const owner = node.parent;
    if (owner && (owner.type === 'function_declaration' || owner.type === 'method_declaration') && owner.childForFieldName('name')?.id === node.id) {
      if (isGoFunction(owner)) return { kind: 'resolved', targets: [createGoFunctionRef(owner, normalizePath(file), parsed.lines)] };
    }
    const literal = literalNamedBy(node);
    if (literal) return { kind: 'resolved', targets: [createGoFunctionRef(literal, normalizePath(file), parsed.lines)] };

    return this.lookup(normalizePath(file), node.startIndex, node.text);
  }

  async getFlow(fn: FunctionRef): Promise<FunctionFlow> {
    const cached = this.flows.get(fn.id);
    if (cached) return cached;
    const parsed = this.parse(fn.file);
    if (!parsed) throw new Error(`Cannot read ${fn.file}.`);

    let node: SyntaxNode | null = parsed.tree.rootNode.descendantForIndex(fn.range.start.offset);
    while (node && !(isGoFunction(node) && node.startIndex === fn.range.start.offset)) node = node.parent;
    if (!node) throw new Error(`Function ${fn.name} was not found at ${fn.file}:${fn.range.start.line + 1}. The file may have changed.`);

    const { flow, callInfo } = extractGoFlow(node, parsed.text, fn.file, parsed.lines);
    this.flows.set(fn.id, flow);
    for (const [id, info] of callInfo) this.callInfo.set(id, { ...info, file: fn.file });
    return flow;
  }

  resolveCall(call: CallSite): Promise<CallResolution> {
    const cached = this.resolutions.get(call.id);
    if (cached) return cached;
    const info = this.callInfo.get(call.id);
    const result: Promise<CallResolution> = !info
      ? Promise.resolve(unresolved('no-symbol', `\`${call.text}\` is no longer available; the source may have changed.`))
      : info.iife
        ? Promise.resolve({ kind: 'resolved', targets: [info.iife] })
        : this.lookup(info.file, info.offset, call.text);
    this.resolutions.set(call.id, result);
    // A language server that has not answered yet (still loading) must not be remembered as "no definition".
    void result.then((r) => {
      if (r.kind === 'unresolved' && r.reason === 'no-symbol' && this.resolutions.get(call.id) === result) this.resolutions.delete(call.id);
    });
    return result;
  }

  invalidate(_file?: string): void {
    this.flows.clear();
    this.callInfo.clear();
    this.resolutions.clear();
  }

  // ---------------------------------------------------------------------------

  /** Parse (or reuse the parse of) a file; unsaved editor text wins over disk. */
  private parse(file: string): ParsedFile | undefined {
    const path = normalizePath(file);
    const text = this.options.readOverlay?.(path) ?? readFile(path);
    if (text === undefined) return undefined;

    const existing = this.parsed.get(path);
    if (existing && existing.text === text) return existing;
    existing?.tree.delete();

    const tree = this.parser.parse(text);
    if (!tree) return undefined;
    const entry: ParsedFile = { text, tree, lines: new LineMap(text) };
    this.parsed.set(path, entry);
    return entry;
  }

  private async lookup(file: string, offset: number, label: string): Promise<CallResolution> {
    const parsed = this.parse(file);
    if (!parsed) return unresolved('no-symbol', `Cannot read ${file}.`);
    const pos = parsed.lines.position(offset);
    const name = toLabel(label, 60);

    let locations: DefinitionLocation[] | undefined;
    try {
      locations = await this.options.lookup.definitions(file, pos.line, pos.character);
    } catch (error) {
      return unresolved('no-symbol', `The language server failed while resolving \`${name}\`: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!locations || locations.length === 0) {
      return unresolved(
        'no-symbol',
        `No definition was found for \`${name}\`. The Go language server (gopls, from the Go extension) must be installed, finished loading, and the folder containing the file's go.mod must be open as a workspace folder.`,
      );
    }

    const targets = new Map<string, FunctionRef>();
    const counts = { external: 0, bodyless: 0, dynamic: 0, 'not-a-function': 0 };
    for (const location of locations) {
      const classified = await this.classify(location);
      if (classified.kind === 'function') targets.set(classified.ref.id, classified.ref);
      else counts[classified.kind]++;
    }

    if (targets.size > 0) return { kind: 'resolved', targets: [...targets.values()] };
    if (counts.external > 0) {
      return unresolved('external-library', `\`${name}\` is defined in the standard library, a dependency or a non-Go file. Library code is not explored.`);
    }
    if (counts.bodyless > 0) {
      return unresolved(
        'declaration-only',
        `\`${name}\` is only declared here (an interface method or a function without a Go body). The concrete implementation depends on the runtime value, so it is not guessed.`,
      );
    }
    if (counts.dynamic > 0) {
      return unresolved('dynamic', `\`${name}\` is a function value (variable, parameter, field or map entry), so its implementation cannot be determined statically.`);
    }
    return unresolved('not-a-function', `\`${name}\` does not refer to a Go function with a body.`);
  }

  private async classify(location: DefinitionLocation): Promise<Classified> {
    const file = normalizePath(location.file);
    if (!file.endsWith('.go') || (await this.isExternal(file))) return { kind: 'external' };
    const parsed = this.parse(file);
    if (!parsed) return { kind: 'external' };

    const offset = parsed.lines.offsetAt(location.line, location.character);
    const node = parsed.tree.rootNode.descendantForIndex(offset);
    if (!node) return { kind: 'not-a-function' };
    const parent = node.parent;

    if (parent && (parent.type === 'function_declaration' || parent.type === 'method_declaration')) {
      return isGoFunction(parent)
        ? { kind: 'function', ref: createGoFunctionRef(parent, file, parsed.lines) }
        : { kind: 'bodyless' };
    }
    // Interface method (the node is called method_spec or method_elem depending on the grammar version).
    if (parent && (parent.type === 'method_spec' || parent.type === 'method_elem')) return { kind: 'bodyless' };
    if (node.type === 'identifier' || node.type === 'field_identifier') {
      const literal = literalNamedBy(node);
      if (literal) return { kind: 'function', ref: createGoFunctionRef(literal, file, parsed.lines) };
      if (parent && ['var_spec', 'short_var_declaration', 'expression_list', 'parameter_declaration', 'field_declaration', 'const_spec'].includes(parent.type)) {
        return { kind: 'dynamic' };
      }
    }
    return { kind: 'not-a-function' };
  }

  private async isExternal(file: string): Promise<boolean> {
    if (/\/pkg\/mod\/|\/vendor\//.test(file)) return true;
    const goroot = await (this.gorootPromise ??= this.detectGoroot());
    if (goroot && file.startsWith(`${normalizePath(goroot)}/`)) return true;
    return /(^|\/)go\/src\//.test(file) && !goroot;
  }

  private detectGoroot(): Promise<string | undefined> {
    if (this.options.goroot) return Promise.resolve(this.options.goroot);
    return new Promise((resolve) => {
      execFile('go', ['env', 'GOROOT'], { timeout: 5000 }, (error, stdout) => resolve(error ? undefined : stdout.trim() || undefined));
    });
  }
}

function readFile(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function unresolved(reason: UnresolvedReason, message: string): CallResolution {
  return { kind: 'unresolved', reason, message };
}

