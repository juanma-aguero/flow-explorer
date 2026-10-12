import * as path from 'path';
import type { CallResolution, CallSite, FunctionFlow, FunctionRef } from '../flow/FlowTypes';
import type { CodeAnalyzer } from './CodeAnalyzer';

export interface LanguageAnalyzer {
  /** Lower-case file extensions including the dot, e.g. `.go`. */
  extensions: readonly string[];
  analyzer: CodeAnalyzer;
}

/** Routes each request to the analyzer for the file's language, so the engine stays language-agnostic. */
export class AnalyzerRegistry implements CodeAnalyzer {
  constructor(private readonly languages: readonly LanguageAnalyzer[]) {}

  private forFile(file: string): CodeAnalyzer | undefined {
    const ext = path.extname(file).toLowerCase();
    return this.languages.find((l) => l.extensions.includes(ext))?.analyzer;
  }

  private require(file: string): CodeAnalyzer {
    const analyzer = this.forFile(file);
    if (!analyzer) throw new Error(`No analyzer supports ${path.basename(file)}.`);
    return analyzer;
  }

  findFunctionAt(file: string, offset: number): Promise<FunctionRef | undefined> {
    return this.forFile(file)?.findFunctionAt(file, offset) ?? Promise.resolve(undefined);
  }

  resolveSymbolAt(file: string, offset: number): Promise<CallResolution | undefined> {
    return this.forFile(file)?.resolveSymbolAt(file, offset) ?? Promise.resolve(undefined);
  }

  getFlow(fn: FunctionRef): Promise<FunctionFlow> {
    return this.require(fn.file).getFlow(fn);
  }

  resolveCall(call: CallSite): Promise<CallResolution> {
    return this.require(call.calleeRange.file).resolveCall(call);
  }

  invalidate(file?: string): void {
    const own = file ? this.forFile(file) : undefined;
    if (own) own.invalidate(file);
    else for (const l of this.languages) l.analyzer.invalidate(file);
  }
}
