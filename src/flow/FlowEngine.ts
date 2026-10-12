import type { CodeAnalyzer } from '../analysis/CodeAnalyzer';
import { FlowNavigator, UserChooser, distinctTargets } from './FlowNavigator';
import { FlowSession } from './FlowSession';
import type { CallSite, FlowSnapshot, FunctionRef, NavigationResult, StepContext } from './FlowTypes';

export type StartResult = { ok: true } | { ok: false; message: string };

export type StartMode =
  /** The function that contains the cursor. */
  | 'enclosing'
  /** The function the identifier under the cursor refers to; steps into it when it is a call of the current step. */
  | 'symbol';

export interface Disposable {
  dispose(): void;
}

const STALE_MESSAGE = 'The source changed after this exploration started, so locations may be wrong. Start a new exploration (Code Flow: Explore from Here).';

/**
 * Facade over analysis + navigation for the UI layer. Owns the single active {@link FlowSession}.
 * Has no dependency on VS Code.
 */
export class FlowEngine {
  private activeSession: FlowSession | undefined;
  private lastMessage: string | undefined;
  private busy = false;
  /** Bumped on every state change; keys the memoised snapshot. */
  private version = 0;
  private memo: { version: number; value: FlowSnapshot } | undefined;
  /** Last snapshot taken before the session went stale; avoids re-analysing edited files on every keystroke. */
  private lastFreshSnapshot: FlowSnapshot | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly navigator: FlowNavigator;

  constructor(
    private readonly analyzer: CodeAnalyzer,
    private readonly chooser: UserChooser,
  ) {
    this.navigator = new FlowNavigator(analyzer, chooser);
  }

  get session(): FlowSession | undefined {
    return this.activeSession;
  }

  get isActive(): boolean {
    return this.activeSession !== undefined;
  }

  onDidChange(listener: () => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  // -- starting / stopping ---------------------------------------------------

  async startAt(file: string, offset: number, mode: StartMode): Promise<StartResult> {
    if (mode === 'symbol') {
      const handled = await this.exploreSymbol(file, offset);
      if (handled) return handled;
    }
    const fn = await this.analyzer.findFunctionAt(file, offset);
    if (!fn) return { ok: false, message: 'No function found at the cursor. Place the cursor inside a function, method or arrow function.' };
    return this.startFromFunction(fn);
  }

  async startFromFunction(fn: FunctionRef): Promise<StartResult> {
    let firstStep: string | null;
    try {
      firstStep = (await this.analyzer.getFlow(fn)).entry;
    } catch (error) {
      return { ok: false, message: errorMessage(error) };
    }
    if (firstStep === null) return { ok: false, message: `\`${fn.name}\` has an empty body: there are no steps to explore.` };

    this.activeSession = new FlowSession(fn, firstStep);
    this.lastMessage = undefined;
    await this.publish();
    return { ok: true };
  }

  stop(): void {
    if (!this.activeSession) return;
    this.activeSession = undefined;
    this.lastMessage = undefined;
    this.version++;
    this.emit();
  }

  /** Marks the session stale when a file it visited was edited. */
  notifyFileChanged(file: string): void {
    const session = this.activeSession;
    this.analyzer.invalidate(file);
    if (!session || session.stale) return;
    for (const fn of session.knownFunctions()) {
      if (fn.file === file) {
        session.stale = true;
        this.version++;
        this.emit();
        return;
      }
    }
  }

  // -- navigation ------------------------------------------------------------

  next(branchId?: string): Promise<NavigationResult> {
    return this.act((s) => this.navigator.next(s, branchId));
  }

  previous(): Promise<NavigationResult> {
    return this.act((s) => this.navigator.previous(s));
  }

  stepInto(call?: Pick<CallSite, 'id'>): Promise<NavigationResult> {
    return this.act((s) => this.navigator.stepInto(s, call));
  }

  stepOut(): Promise<NavigationResult> {
    return this.act((s) => this.navigator.stepOut(s));
  }

  // -- read models -----------------------------------------------------------

  async snapshot(): Promise<FlowSnapshot | undefined> {
    const session = this.activeSession;
    if (!session) return undefined;
    if (session.stale) {
      return this.lastFreshSnapshot && { ...this.lastFreshSnapshot, stale: true, canGoBack: false, message: STALE_MESSAGE };
    }
    if (this.memo?.version === this.version) return this.memo.value;
    const version = this.version;
    const { flow, step } = await this.navigator.currentStep(session);

    const calls = await Promise.all(
      step.calls.map(async (call) => {
        const resolution = await this.analyzer.resolveCall(call);
        return resolution.kind === 'resolved'
          ? { id: call.id, text: call.text, canStepInto: true }
          : { id: call.id, text: call.text, canStepInto: false, note: resolution.message };
      }),
    );

    const callStack = session.frames.map((frame) => {
      const fn = session.functionOf(frame.functionId);
      return { functionName: fn.name, file: fn.file, line: fn.range.start.line + 1 };
    });

    const callerRanges = await Promise.all(
      session.frames.slice(0, -1).map(async (frame) => {
        const callerFlow = await this.analyzer.getFlow(session.functionOf(frame.functionId));
        return (callerFlow.steps.find((s) => s.id === frame.stepId) ?? callerFlow.steps[0]).range;
      }),
    );

    const snapshot: FlowSnapshot = {
      flowName: session.entry.name,
      functionName: flow.function.name,
      file: flow.function.file,
      stepNumber: step.index + 1,
      stepCount: flow.steps.length,
      step: {
        id: step.id,
        kind: step.kind,
        label: step.label,
        awaits: step.awaits,
        range: step.range,
        calls,
        branches: step.branches.map((b) => ({ id: b.id, label: b.label })),
      },
      callStack,
      callerRanges,
      canStepInto: step.calls.length > 0,
      canStepOut: session.depth > 1,
      canGoBack: session.canGoBack,
      atEnd: distinctTargets(step).every((t) => t === null),
      stale: false,
      warnings: flow.warnings,
      message: this.lastMessage,
    };
    this.lastFreshSnapshot = snapshot;
    if (version === this.version) this.memo = { version, value: snapshot };
    return snapshot;
  }

  /** The minimum code context needed to explain the current step. */
  async stepContext(): Promise<StepContext | undefined> {
    const session = this.activeSession;
    if (!session || session.stale) return undefined;
    const { flow, step } = await this.navigator.currentStep(session);
    const calls = await Promise.all(
      step.calls.map(async (call) => {
        const resolution = await this.analyzer.resolveCall(call);
        return resolution.kind === 'resolved'
          ? { text: call.text, resolvedTo: resolution.targets.map((t) => t.name).join(' | ') }
          : { text: call.text, unresolvedReason: resolution.reason };
      }),
    );
    return {
      flowName: session.entry.name,
      functionName: flow.function.name,
      file: flow.function.file,
      callStack: session.frames.map((f) => session.functionOf(f.functionId).name),
      stepKind: step.kind,
      stepText: step.text,
      functionSource: flow.source,
      stepLineInFunction: step.range.start.line - flow.function.range.start.line,
      branches: step.branches.map((b) => b.label),
      calls,
    };
  }

  // -- internals -------------------------------------------------------------

  private async exploreSymbol(file: string, offset: number): Promise<StartResult | undefined> {
    const session = this.activeSession;
    if (session && !session.stale) {
      const { step } = await this.navigator.currentStep(session);
      const call = step.calls.find(
        (c) => c.calleeRange.file === file && offset >= c.calleeRange.start.offset && offset <= c.calleeRange.end.offset,
      );
      if (call) {
        const result = await this.stepInto(call);
        return result.moved ? { ok: true } : { ok: false, message: result.message ?? 'Step Into was cancelled.' };
      }
    }

    const resolution = await this.analyzer.resolveSymbolAt(file, offset);
    if (!resolution) return undefined; // not on an identifier: fall back to the enclosing function
    if (resolution.kind === 'unresolved') {
      return { ok: false, message: `${resolution.message} Use "Explore from Here" to explore the enclosing function instead.` };
    }
    let target: FunctionRef | undefined = resolution.targets[0];
    if (resolution.targets.length > 1) {
      target = await this.chooser.chooseTarget(target.name, resolution.targets);
      if (!target) return { ok: false, message: 'Cancelled.' };
    }
    return this.startFromFunction(target);
  }

  private async act(action: (session: FlowSession) => Promise<NavigationResult> | NavigationResult): Promise<NavigationResult> {
    const session = this.activeSession;
    if (!session) return { moved: false, message: 'No active exploration. Run "Code Flow: Explore from Here" first.' };
    if (session.stale) return { moved: false, message: STALE_MESSAGE };
    if (this.busy) return { moved: false, message: 'Another navigation action is waiting for your input.' };

    this.busy = true;
    try {
      const result = await action(session);
      this.lastMessage = result.message;
      await this.publish();
      return result;
    } catch (error) {
      const message = errorMessage(error);
      this.lastMessage = message;
      await this.publish();
      return { moved: false, message };
    } finally {
      this.busy = false;
    }
  }

  /** Records a state change, primes the snapshot (kept for the stale view), then notifies listeners. */
  private async publish(): Promise<void> {
    this.version++;
    try {
      await this.snapshot();
    } catch {
      // The snapshot is also computed by listeners, which report the error themselves.
    }
    this.emit();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
