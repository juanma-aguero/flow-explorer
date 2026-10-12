import * as path from 'path';
import * as ts from 'typescript';
import type { CallResolution, CallSite, FunctionFlow, FunctionRef } from '../flow/FlowTypes';
import { FunctionLike, createFunctionRef, findInnermostNode, isFunctionLikeWithBody, normalizePath, unwrapExpression } from './astUtils';
import type { CodeAnalyzer } from './CodeAnalyzer';
import { SymbolResolver } from './SymbolResolver';
import { CallNode, extractFlow } from './StepExtractor';

export interface TypeScriptAnalyzerOptions {
  /** Returns unsaved editor contents for a file, so analysis matches what the user sees. */
  readOverlay?: (file: string) => string | undefined;
  /**
   * Directory containing TypeScript's `lib.*.d.ts` files. Needed when the compiler is bundled
   * (it then cannot find them next to itself). Defaults to the TypeScript package's own lib folder.
   */
  libDirectory?: string;
}

interface ProgramEntry {
  program: ts.Program;
  resolver: SymbolResolver;
}

interface CachedSource {
  text: string;
  languageKey: string;
  sourceFile: ts.SourceFile;
}

function functionNamedBy(node: ts.Node): { name: ts.Node; fn: FunctionLike } | undefined {
  if (!ts.isVariableDeclaration(node) && !ts.isPropertyDeclaration(node) && !ts.isPropertyAssignment(node)) return undefined;
  if (!node.initializer) return undefined;
  const init = unwrapExpression(node.initializer);
  return isFunctionLikeWithBody(init) ? { name: node.name, fn: init } : undefined;
}

const DEFAULT_OPTIONS: ts.CompilerOptions = {
  allowJs: true,
  checkJs: false,
  noEmit: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.Preserve,
  esModuleInterop: true,
  resolveJsonModule: true,
  skipLibCheck: true,
  types: [],
};

/**
 * Analyzer built on the TypeScript Compiler API.
 *
 * - Uses the nearest tsconfig.json / jsconfig.json when there is one, otherwise permissive JS-friendly defaults.
 * - Builds one `ts.Program` per config lazily, and rebuilds it only after {@link invalidate}.
 * - Analyses functions lazily; there is no whole-project call graph.
 */
export class TypeScriptAnalyzer implements CodeAnalyzer {
  private readonly entries = new Map<string, ProgramEntry>();
  private readonly oldPrograms = new Map<string, ts.Program>();
  private readonly sourceCache = new Map<string, CachedSource>();
  private readonly configCache = new Map<string, string | null>();
  private readonly flows = new Map<string, FunctionFlow>();
  private readonly callNodes = new Map<string, CallNode>();
  private readonly callResolver = new Map<string, SymbolResolver>();

  constructor(private readonly options: TypeScriptAnalyzerOptions = {}) {}

  async findFunctionAt(file: string, offset: number): Promise<FunctionRef | undefined> {
    const sf = this.getSourceFile(file);
    if (!sf) return undefined;
    let candidate: FunctionLike | undefined;
    const visit = (node: ts.Node): void => {
      if (offset >= node.getStart(sf) && offset <= node.getEnd()) {
        if (isFunctionLikeWithBody(node)) candidate = node;
        // `const handler = () => {...}`: the cursor on the name selects the function it names.
        const named = functionNamedBy(node);
        if (named && offset >= named.name.getStart(sf) && offset <= named.name.getEnd()) candidate = named.fn;
        ts.forEachChild(node, visit);
      }
    };
    ts.forEachChild(sf, visit);
    return candidate ? createFunctionRef(candidate, sf) : undefined;
  }

  async resolveSymbolAt(file: string, offset: number): Promise<CallResolution | undefined> {
    const entry = this.getEntry(file);
    const sf = entry?.program.getSourceFile(normalizePath(file));
    if (!entry || !sf) return undefined;
    const node = findInnermostNode(sf, offset);
    if (!ts.isIdentifier(node) && !ts.isPrivateIdentifier(node)) return undefined;
    return entry.resolver.resolveIdentifier(node);
  }

  async getFlow(fn: FunctionRef): Promise<FunctionFlow> {
    const cached = this.flows.get(fn.id);
    if (cached) return cached;

    const entry = this.getEntry(fn.file);
    const sf = entry?.program.getSourceFile(fn.file);
    if (!entry || !sf) throw new Error(`Cannot analyse ${fn.file}: file is not part of any program.`);

    const node = this.findFunctionNode(sf, fn.range.start.offset);
    if (!node) throw new Error(`Function ${fn.name} was not found at ${fn.file}:${fn.range.start.line + 1}. The file may have changed.`);

    const { flow, callNodes } = extractFlow(node, sf);
    this.flows.set(fn.id, flow);
    for (const [id, call] of callNodes) {
      this.callNodes.set(id, call);
      this.callResolver.set(id, entry.resolver);
    }
    return flow;
  }

  async resolveCall(call: CallSite): Promise<CallResolution> {
    const node = this.callNodes.get(call.id);
    const resolver = this.callResolver.get(call.id);
    if (!node || !resolver) {
      return { kind: 'unresolved', reason: 'no-symbol', message: `\`${call.text}\` is no longer available; the source may have changed.` };
    }
    return resolver.resolveCall(node);
  }

  invalidate(_file?: string): void {
    for (const [key, entry] of this.entries) this.oldPrograms.set(key, entry.program);
    this.entries.clear();
    this.flows.clear();
    this.callNodes.clear();
    this.callResolver.clear();
  }

  // ---------------------------------------------------------------------------

  private findFunctionNode(sf: ts.SourceFile, startOffset: number): FunctionLike | undefined {
    let found: FunctionLike | undefined;
    const visit = (node: ts.Node): void => {
      if (found || startOffset < node.pos || startOffset > node.end) return;
      if (isFunctionLikeWithBody(node) && node.getStart(sf) === startOffset) {
        found = node;
        return;
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
    return found;
  }

  private getSourceFile(file: string): ts.SourceFile | undefined {
    return this.getEntry(file)?.program.getSourceFile(normalizePath(file));
  }

  /** Program (and resolver) that contains `file`; falls back to an ad-hoc program for files outside the tsconfig. */
  private getEntry(file: string): ProgramEntry | undefined {
    const normalized = normalizePath(path.resolve(file));
    const configPath = this.findConfig(normalized);

    if (configPath) {
      const entry = this.ensureProgram(`config:${configPath}`, () => this.loadConfig(configPath));
      if (entry.program.getSourceFile(normalized)) return entry;
    }
    const adhocKey = `adhoc:${normalized}`;
    return this.ensureProgram(adhocKey, () => {
      const base = configPath ? this.loadConfig(configPath).options : DEFAULT_OPTIONS;
      return { rootNames: [normalized], options: base };
    });
  }

  private ensureProgram(key: string, load: () => { rootNames: string[]; options: ts.CompilerOptions }): ProgramEntry {
    const existing = this.entries.get(key);
    if (existing) return existing;

    const { rootNames, options } = load();
    const host = this.createHost(options);
    const program = ts.createProgram({ rootNames, options, host, oldProgram: this.oldPrograms.get(key) });
    const entry: ProgramEntry = { program, resolver: new SymbolResolver(program, program.getTypeChecker()) };
    this.entries.set(key, entry);
    this.oldPrograms.delete(key);
    return entry;
  }

  private findConfig(file: string): string | undefined {
    const dir = path.dirname(file);
    const cached = this.configCache.get(dir);
    if (cached !== undefined) return cached ?? undefined;
    const found =
      ts.findConfigFile(dir, ts.sys.fileExists, 'tsconfig.json') ?? ts.findConfigFile(dir, ts.sys.fileExists, 'jsconfig.json');
    const result = found ? normalizePath(path.resolve(found)) : null;
    this.configCache.set(dir, result);
    return result ?? undefined;
  }

  private loadConfig(configPath: string): { rootNames: string[]; options: ts.CompilerOptions } {
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(read.config ?? {}, ts.sys, path.dirname(configPath), undefined, configPath);
    const options: ts.CompilerOptions = {
      ...parsed.options,
      // Analysis only: never emit, and let JS files that TS files import be understood.
      allowJs: true,
      noEmit: true,
      composite: false,
      incremental: false,
      declaration: false,
      declarationMap: false,
      emitDeclarationOnly: false,
      tsBuildInfoFile: undefined,
      skipLibCheck: true,
    };
    return { rootNames: parsed.fileNames, options };
  }

  /** Compiler host that serves unsaved editor text and reuses unchanged parsed files across rebuilds. */
  private createHost(options: ts.CompilerOptions): ts.CompilerHost {
    const host = ts.createCompilerHost(options, true);
    const overlay = this.options.readOverlay;
    const baseReadFile = host.readFile.bind(host);
    const readText = (fileName: string): string | undefined => overlay?.(normalizePath(fileName)) ?? baseReadFile(fileName);

    const libDir = this.options.libDirectory;
    if (libDir) {
      host.getDefaultLibLocation = () => libDir;
      host.getDefaultLibFileName = (opts) => normalizePath(path.join(libDir, ts.getDefaultLibFileName(opts)));
    }

    host.readFile = readText;
    host.getSourceFile = (fileName, languageVersionOrOptions, onError) => {
      const text = readText(fileName);
      if (text === undefined) {
        onError?.(`File not found: ${fileName}`);
        return undefined;
      }
      const languageKey = JSON.stringify(languageVersionOrOptions);
      const cached = this.sourceCache.get(fileName);
      if (cached && cached.text === text && cached.languageKey === languageKey) return cached.sourceFile;
      const sourceFile = ts.createSourceFile(fileName, text, languageVersionOrOptions, true);
      this.sourceCache.set(fileName, { text, languageKey, sourceFile });
      return sourceFile;
    };
    return host;
  }
}
