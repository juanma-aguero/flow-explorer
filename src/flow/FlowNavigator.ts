import type { CodeAnalyzer } from '../analysis/CodeAnalyzer';
import { FlowSession, MAX_CALL_DEPTH } from './FlowSession';
import type { Branch, CallResolution, CallSite, FlowStep, FunctionFlow, FunctionRef, NavigationResult } from './FlowTypes';

export interface CallOption {
  call: CallSite;
  resolution: CallResolution;
}

/** Decisions that only the user can make. The VS Code implementation uses Quick Picks. */
export interface UserChooser {
  /** Pick which path to explore at a branching step. Resolve `undefined` to cancel. */
  chooseBranch(step: FlowStep, branches: readonly Branch[], previousChoice?: string): Promise<Branch | undefined>;
  /** Pick which call of a step to step into. */
  chooseCall(step: FlowStep, options: readonly CallOption[]): Promise<CallOption | undefined>;
  /** Pick between several possible implementations of one call. */
  chooseTarget(label: string, targets: readonly FunctionRef[]): Promise<FunctionRef | undefined>;
}

const NOT_MOVED = (message?: string): NavigationResult => ({ moved: false, message });

/**
 * Debugger-style navigation over a {@link FlowSession}. Contains all stepping rules; holds no state itself.
 */
export class FlowNavigator {
  constructor(
    private readonly analyzer: CodeAnalyzer,
    private readonly chooser: UserChooser,
  ) {}

  async currentStep(session: FlowSession): Promise<{ flow: FunctionFlow; step: FlowStep }> {
    const frame = session.activeFrame;
    const flow = await this.analyzer.getFlow(session.functionOf(frame.functionId));
    const step = flow.steps.find((s) => s.id === frame.stepId);
    if (!step) throw new Error(`Step ${frame.stepId} not found in ${flow.function.name}`);
    return { flow, step };
  }

  /** `branchId` picks the path directly (clicked in the sidebar); otherwise the user is asked. */
  async next(session: FlowSession, branchId?: string): Promise<NavigationResult> {
    const { flow, step } = await this.currentStep(session);
    const targets = distinctTargets(step);

    if (step.branches.length > 1 && targets.length > 1) {
      const choice =
        step.branches.find((b) => b.id === branchId) ??
        (await this.chooser.chooseBranch(step, step.branches, session.choiceAt(step.id)));
      if (!choice) return NOT_MOVED();
      session.recordBranch(step.id, choice.id);
      return this.goTo(session, choice.target, flow);
    }

    const target = step.branches.length > 0 ? step.branches[0].target : step.next;
    return this.goTo(session, target, flow);
  }

  previous(session: FlowSession): NavigationResult {
    if (!session.back()) return NOT_MOVED('Already at the first step of this exploration.');
    return { moved: true };
  }

  async stepInto(session: FlowSession, only?: Pick<CallSite, 'id'>): Promise<NavigationResult> {
    const { step } = await this.currentStep(session);
    if (step.calls.length === 0) return NOT_MOVED('This step contains no function call to step into.');

    const options: CallOption[] = await Promise.all(
      (only ? step.calls.filter((c) => c.id === only.id) : step.calls).map(async (call) => ({
        call,
        resolution: await this.analyzer.resolveCall(call),
      })),
    );
    if (options.length === 0) return NOT_MOVED('That call is not part of the current step.');

    let option: CallOption | undefined = options[0];
    if (options.length > 1) {
      option = await this.chooser.chooseCall(step, options);
      if (!option) return NOT_MOVED();
    }

    if (option.resolution.kind === 'unresolved') return NOT_MOVED(option.resolution.message);

    let target: FunctionRef | undefined = option.resolution.targets[0];
    if (option.resolution.targets.length > 1) {
      target = await this.chooser.chooseTarget(option.call.text, option.resolution.targets);
      if (!target) return NOT_MOVED();
    }

    return this.enter(session, target);
  }

  /** Enters `target` as a new frame (shared by Step Into and "Explore Function" on a call). */
  async enter(session: FlowSession, target: FunctionRef): Promise<NavigationResult> {
    if (session.isOnStack(target.id)) {
      return NOT_MOVED(
        `\`${target.name}\` is already on the call stack (recursion). It is not entered again; use Next to continue after the call.`,
      );
    }
    if (session.depth >= MAX_CALL_DEPTH) {
      return NOT_MOVED(`Call stack limit (${MAX_CALL_DEPTH}) reached; not stepping deeper.`);
    }

    const flow = await this.analyzer.getFlow(target);
    if (flow.entry === null) return NOT_MOVED(`\`${target.name}\` has an empty body: there are no steps to explore.`);

    session.register(target);
    session.push({ frames: [...session.frames, { functionId: target.id, stepId: flow.entry }] });
    return { moved: true };
  }

  stepOut(session: FlowSession): NavigationResult {
    if (session.depth < 2) return NOT_MOVED('Already in the entry function; there is no caller to return to.');
    session.push({ frames: session.frames.slice(0, -1) });
    return { moved: true };
  }

  private goTo(session: FlowSession, target: string | null, flow: FunctionFlow): NavigationResult {
    if (target === null) {
      if (session.depth > 1) {
        const caller = session.functionOf(session.frames[session.depth - 2].functionId);
        const result = this.stepOut(session);
        return { ...result, message: `Reached the end of \`${flow.function.name}\`; back in \`${caller.name}\`.` };
      }
      return NOT_MOVED(`Reached the end of \`${flow.function.name}\`; there are no further steps.`);
    }
    session.push({ frames: [...session.frames.slice(0, -1), { ...session.activeFrame, stepId: target }] });
    return { moved: true };
  }
}

/** Distinct, ordered successor ids of a step. */
export function distinctTargets(step: FlowStep): Array<string | null> {
  if (step.branches.length === 0) return [step.next];
  return [...new Set(step.branches.map((b) => b.target))];
}
