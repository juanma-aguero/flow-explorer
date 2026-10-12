import * as fs from 'fs';
import * as path from 'path';
import { TypeScriptAnalyzer } from '../src/analysis/TypeScriptAnalyzer';
import type { CallOption, UserChooser } from '../src/flow/FlowNavigator';
import type { Branch, FlowStep, FunctionRef } from '../src/flow/FlowTypes';
import type { CodeAnalyzer } from '../src/analysis/CodeAnalyzer';

/** Repository root, resolved from the compiled location (out/test/helpers.js). */
export const ROOT = path.resolve(__dirname, '..', '..');
export const FIXTURES = path.join(ROOT, 'test', 'fixtures').replace(/\\/g, '/');
export const DEMO = path.join(ROOT, 'examples', 'checkout-demo').replace(/\\/g, '/');

export const fixture = (name: string): string => `${FIXTURES}/${name}`;
export const demo = (name: string): string => `${DEMO}/${name}`;

/** Offset of `needle` (the last character of it) in the file; use to place a cursor inside a function. */
export function offsetOf(file: string, needle: string, occurrence = 0): number {
  const text = fs.readFileSync(file, 'utf8');
  let index = -1;
  for (let i = 0; i <= occurrence; i++) {
    index = text.indexOf(needle, index + 1);
    if (index < 0) throw new Error(`"${needle}" (#${occurrence}) not found in ${file}`);
  }
  return index + needle.length - 1;
}

export async function functionAt(analyzer: CodeAnalyzer, file: string, needle: string): Promise<FunctionRef> {
  const fn = await analyzer.findFunctionAt(file, offsetOf(file, needle));
  if (!fn) throw new Error(`No function at "${needle}" in ${file}`);
  return fn;
}

export const newAnalyzer = (): TypeScriptAnalyzer => new TypeScriptAnalyzer();

/**
 * Answers the user prompts from scripted lists and records what was asked.
 * Branch ids / call texts / function names are consumed in order; `undefined` entries cancel.
 */
export class ScriptedChooser implements UserChooser {
  readonly asked: string[] = [];

  constructor(
    private readonly script: { branches?: Array<string | undefined>; calls?: Array<string | undefined>; targets?: Array<string | undefined> } = {},
  ) {}

  async chooseBranch(step: FlowStep, branches: readonly Branch[]): Promise<Branch | undefined> {
    this.asked.push(`branch:${step.label}`);
    const wanted = this.script.branches?.shift();
    return wanted === undefined ? undefined : branches.find((b) => b.id === wanted);
  }

  async chooseCall(step: FlowStep, options: readonly CallOption[]): Promise<CallOption | undefined> {
    this.asked.push(`call:${step.label}`);
    const wanted = this.script.calls?.shift();
    return wanted === undefined ? undefined : options.find((o) => o.call.text === wanted);
  }

  async chooseTarget(label: string, targets: readonly FunctionRef[]): Promise<FunctionRef | undefined> {
    this.asked.push(`target:${label}`);
    const wanted = this.script.targets?.shift();
    return wanted === undefined ? undefined : targets.find((t) => t.name === wanted);
  }
}
