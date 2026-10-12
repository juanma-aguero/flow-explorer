/**
 * Domain types shared by the analysis engine, the flow engine and the UI layers.
 * Nothing in here depends on VS Code, so the whole core is unit-testable in plain Node.
 */

/** A zero-based position. `offset` is a UTF-16 offset into the file text. */
export interface SourcePosition {
  line: number;
  character: number;
  offset: number;
}

export interface SourceRange {
  /** Absolute file path using forward slashes. */
  file: string;
  start: SourcePosition;
  end: SourcePosition;
}

export type StepKind =
  | 'assignment'
  | 'call'
  | 'expression'
  | 'condition'
  | 'loop'
  | 'switch'
  | 'try'
  | 'catch'
  | 'finally'
  | 'return'
  | 'throw'
  | 'jump'
  | 'defer'
  | 'go'
  | 'other';

/** A call (or `new`) expression found directly in a step, i.e. not inside a nested function. */
export interface CallSite {
  /** Stable within the owning function: `<stepId>/c<n>`. */
  id: string;
  /** Callee as written, e.g. `applyDiscount` or `this.repo.save`. */
  text: string;
  isNew: boolean;
  /** Whether the call is the operand of an `await`. */
  awaited: boolean;
  /** Range of the callee name (the identifier used for symbol resolution). */
  calleeRange: SourceRange;
}

export interface Branch {
  /** Unique within the step. */
  id: string;
  label: string;
  /** Step to continue with, or null when the branch leaves the function. */
  target: string | null;
}

export interface FlowStep {
  /** Stable identifier: `<functionId>/s<index>`. */
  id: string;
  /** Position in source order within the function (0-based). */
  index: number;
  kind: StepKind;
  /** Single-line, truncated description of the step. */
  label: string;
  /** Full statement text (or header text for compound statements). */
  text: string;
  range: SourceRange;
  /** Whether the step awaits something. */
  awaits: boolean;
  calls: CallSite[];
  /** Linear successor. `null` ends the function. Ignored when `branches` has more than one target. */
  next: string | null;
  /** Non-empty for steps where the static analysis cannot know which path is taken. */
  branches: Branch[];
}

export type FunctionKind = 'function' | 'method' | 'arrow' | 'function-expression' | 'constructor' | 'accessor';

/** Lightweight, serialisable reference to a function-like declaration. */
export interface FunctionRef {
  /** `<file>#<qualifiedName>@<startOffset>` */
  id: string;
  name: string;
  kind: FunctionKind;
  file: string;
  /** Range of the whole function. */
  range: SourceRange;
  /** Range of the name, when the function has one. */
  nameRange?: SourceRange;
}

/** All steps of one function, in source order, plus the wiring between them. */
export interface FunctionFlow {
  function: FunctionRef;
  steps: FlowStep[];
  /** First step to execute, or null for an empty function. */
  entry: string | null;
  /** Source of the whole function, used to build AI context. */
  source: string;
  /** Constructs the analysis could not model faithfully, shown to the user. */
  warnings: string[];
}

export type UnresolvedReason =
  | 'no-symbol'
  | 'external-library'
  | 'declaration-only'
  | 'no-implementation'
  | 'dynamic'
  | 'not-a-function';

export type CallResolution =
  | { kind: 'resolved'; targets: FunctionRef[] }
  | { kind: 'unresolved'; reason: UnresolvedReason; message: string };

/** One frame of the exploration call stack. */
export interface Frame {
  functionId: string;
  /** The step currently highlighted in this frame. */
  stepId: string;
}

/** Immutable position of an exploration. The last frame is the active one. */
export interface FlowState {
  frames: readonly Frame[];
}

export interface NavigationResult {
  /** True when the position changed. */
  moved: boolean;
  /** Human readable explanation, set when nothing happened or something notable did. */
  message?: string;
}

/** Read-only view of the current position, shaped for the sidebar, highlights and context keys. */
export interface FlowSnapshot {
  flowName: string;
  functionName: string;
  file: string;
  /** 1-based position of the step in source order within its function. */
  stepNumber: number;
  stepCount: number;
  step: {
    id: string;
    kind: StepKind;
    label: string;
    awaits: boolean;
    range: SourceRange;
    calls: Array<{ text: string; canStepInto: boolean; note?: string }>;
    branches: Array<{ id: string; label: string }>;
  };
  /** Outermost frame first. */
  callStack: Array<{ functionName: string; file: string; line: number }>;
  /** Call-site ranges of the frames waiting below the active one, innermost last. */
  callerRanges: SourceRange[];
  canStepInto: boolean;
  canStepOut: boolean;
  canGoBack: boolean;
  /** True when the step has no successor (the function ends here). */
  atEnd: boolean;
  /** Source changed after the session started; navigation is disabled until restarted. */
  stale: boolean;
  /** Notable limitations of the analysis for the current function. */
  warnings: string[];
  /** Feedback from the last action, e.g. why Step Into was refused. */
  message?: string;
}

/** Minimal code context handed to the AI layer. */
export interface StepContext {
  flowName: string;
  functionName: string;
  file: string;
  callStack: string[];
  stepKind: StepKind;
  stepText: string;
  /** Source of the enclosing function. */
  functionSource: string;
  /** 0-based line of the step relative to the start of `functionSource`. */
  stepLineInFunction: number;
  branches: string[];
  calls: Array<{ text: string; resolvedTo?: string; unresolvedReason?: string }>;
}
