import type { FlowState, Frame, FunctionRef } from './FlowTypes';

/** Hard stop against runaway Step Into chains. */
export const MAX_CALL_DEPTH = 64;

/**
 * State of one exploration.
 *
 * Every navigation action pushes an immutable {@link FlowState} onto `history`; "Previous" pops it.
 * That makes Previous the exact inverse of whatever the user did last (including Step Into/Out and
 * branch choices) and means nothing is ever re-analysed to go back.
 */
export class FlowSession {
  private readonly history: FlowState[];
  private readonly functions = new Map<string, FunctionRef>();
  /** Latest branch chosen at each branching step. */
  private readonly branchChoices = new Map<string, string>();
  stale = false;

  constructor(
    readonly entry: FunctionRef,
    firstStepId: string,
  ) {
    this.functions.set(entry.id, entry);
    this.history = [{ frames: [{ functionId: entry.id, stepId: firstStepId }] }];
  }

  get state(): FlowState {
    return this.history[this.history.length - 1];
  }

  get frames(): readonly Frame[] {
    return this.state.frames;
  }

  get activeFrame(): Frame {
    return this.frames[this.frames.length - 1];
  }

  get depth(): number {
    return this.frames.length;
  }

  get canGoBack(): boolean {
    return this.history.length > 1;
  }

  /** Number of states recorded, including the initial one. */
  get historyLength(): number {
    return this.history.length;
  }

  functionOf(id: string): FunctionRef {
    const fn = this.functions.get(id);
    if (!fn) throw new Error(`Unknown function ${id} in session`);
    return fn;
  }

  knownFunctions(): Iterable<FunctionRef> {
    return this.functions.values();
  }

  register(fn: FunctionRef): void {
    this.functions.set(fn.id, fn);
  }

  isOnStack(functionId: string): boolean {
    return this.frames.some((f) => f.functionId === functionId);
  }

  push(state: FlowState): void {
    this.history.push(state);
  }

  /** Undo the last action. Returns false when already at the start. */
  back(): boolean {
    if (this.history.length <= 1) return false;
    this.history.pop();
    return true;
  }

  recordBranch(stepId: string, branchId: string): void {
    this.branchChoices.set(stepId, branchId);
  }

  choiceAt(stepId: string): string | undefined {
    return this.branchChoices.get(stepId);
  }

  /** All branch choices made so far (stepId → branchId). */
  get selectedBranches(): ReadonlyMap<string, string> {
    return this.branchChoices;
  }
}
