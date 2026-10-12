import type { CallResolution, CallSite, FunctionFlow, FunctionRef } from '../flow/FlowTypes';

/**
 * Everything the flow engine needs from static analysis. Async because some languages resolve symbols through
 * a language server.
 * The only implementation today is {@link TypeScriptAnalyzer}; keeping this interface small lets tests
 * (and, later, other languages or a PR-diff aware analyzer) plug in without touching the engine.
 */
export interface CodeAnalyzer {
  /** Innermost function with a body that contains the offset. */
  findFunctionAt(file: string, offset: number): Promise<FunctionRef | undefined>;

  /**
   * Function referred to by the identifier at the offset (a call target or a declaration name),
   * or an `unresolved` result explaining why not. Returns undefined when there is no identifier there.
   */
  resolveSymbolAt(file: string, offset: number): Promise<CallResolution | undefined>;

  /** Lazily analyses one function. Cached until {@link invalidate}. */
  getFlow(fn: FunctionRef): Promise<FunctionFlow>;

  resolveCall(call: CallSite): Promise<CallResolution>;

  /** Drops cached analysis; call when files change on disk or in editors. */
  invalidate(file?: string): void;
}
