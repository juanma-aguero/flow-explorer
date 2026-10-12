import type { StepContext } from '../flow/FlowTypes';

export function systemPrompt(language: string): string {
  return [
  `You explain ${language} code to a developer who is reading it for the first time.`,
  'The code is being explored STATICALLY: nothing is running. Only use what is visible in the code you are given.',
  'Rules:',
  '- Never invent runtime values, inputs, outputs, or which branch is taken.',
  '- If something depends on code you were not shown (for example a called function), say what the call is used for from its name and arguments, and say its behavior is not visible here.',
  '- Be concise: 2-4 sentences of plain prose, no headings, no code blocks, no bullet lists.',
  '- Focus on the CURRENT STEP and why it matters for the surrounding function.',
  ].join('\n');
}

/** Language name for the prompt, from the file extension. */
export function languageOf(file: string): string {
  if (file.endsWith('.go')) return 'Go';
  if (/\.(tsx?|mts|cts)$/.test(file)) return 'TypeScript';
  return 'JavaScript';
}

export interface BuiltPrompt {
  system: string;
  prompt: string;
  /** Characters of user source code included, for transparency in the UI. */
  sourceChars: number;
}

/**
 * Builds the smallest useful prompt: the current step, the enclosing function (windowed around the step when it is
 * long) and a few facts from the static analysis. No other files, no secrets, no project metadata.
 */
export function buildPrompt(ctx: StepContext, maxContextChars: number): BuiltPrompt {
  const source = windowSource(ctx.functionSource, ctx.stepLineInFunction, maxContextChars);
  const stepText = ctx.stepText.length > maxContextChars ? `${ctx.stepText.slice(0, maxContextChars)}…` : ctx.stepText;

  const facts: string[] = [];
  facts.push(`File: ${basename(ctx.file)}`);
  facts.push(`Enclosing function: ${ctx.functionName}`);
  if (ctx.callStack.length > 1) facts.push(`Reached via: ${ctx.callStack.join(' → ')}`);
  facts.push(`Step kind: ${ctx.stepKind}`);
  if (ctx.branches.length > 0) {
    facts.push(`The analysis cannot know which path is taken. Possible paths: ${ctx.branches.join('; ')}`);
  }
  for (const call of ctx.calls) {
    if (call.resolvedTo) facts.push(`Call \`${call.text}\` resolves statically to: ${call.resolvedTo} (its body is not shown)`);
    else facts.push(`Call \`${call.text}\` could not be resolved statically (${call.unresolvedReason ?? 'unknown'})`);
  }

  const prompt = [
    ...facts,
    '',
    'ENCLOSING FUNCTION SOURCE:',
    source,
    '',
    'CURRENT STEP:',
    stepText,
    '',
    'Explain the current step.',
  ].join('\n');

  return { system: systemPrompt(languageOf(ctx.file)), prompt, sourceChars: source.length + stepText.length };
}

/** Returns the whole source when it fits, otherwise the signature plus a window of lines around the step. */
export function windowSource(source: string, stepLine: number, maxChars: number): string {
  if (source.length <= maxChars) return source;
  const lines = source.split('\n');
  const marker = '// … (lines omitted)';
  const kept = new Set<number>([0]);
  let budget = maxChars - lines[0].length - 2 * (marker.length + 1);
  let lo = Math.min(Math.max(stepLine, 0), lines.length - 1);
  let hi = lo;

  const take = (i: number): boolean => {
    if (i < 0 || i >= lines.length || kept.has(i)) return false;
    if (lines[i].length + 1 > budget) return false;
    budget -= lines[i].length + 1;
    kept.add(i);
    return true;
  };

  take(lo);
  for (let progress = true; progress; ) {
    progress = false;
    if (take(lo - 1)) {
      lo--;
      progress = true;
    }
    if (take(hi + 1)) {
      hi++;
      progress = true;
    }
  }

  const out: string[] = [];
  let previous = -1;
  for (const i of [...kept].sort((a, b) => a - b)) {
    if (previous !== -1 && i !== previous + 1) out.push(marker);
    out.push(lines[i]);
    previous = i;
  }
  if (previous < lines.length - 1) out.push(marker);
  return out.join('\n');
}

function basename(file: string): string {
  return file.slice(file.lastIndexOf('/') + 1);
}
