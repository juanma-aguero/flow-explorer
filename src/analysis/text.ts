import type { SourcePosition, SourceRange } from '../flow/FlowTypes';

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Collapses whitespace and truncates to a single line for display. */
export function toLabel(text: string, max = 120): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

/** Converts between UTF-16 offsets and zero-based line/character positions, as VS Code uses them. */
export class LineMap {
  private readonly starts: number[] = [0];

  constructor(private readonly text: string) {
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 10) this.starts.push(i + 1);
      else if (c === 13) {
        if (text.charCodeAt(i + 1) === 10) i++;
        this.starts.push(i + 1);
      }
    }
  }

  position(offset: number): SourcePosition {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo, character: offset - this.starts[lo], offset };
  }

  offsetAt(line: number, character: number): number {
    const start = this.starts[Math.min(Math.max(line, 0), this.starts.length - 1)];
    return Math.min(start + character, this.text.length);
  }

  range(file: string, start: number, end: number): SourceRange {
    return { file, start: this.position(start), end: this.position(end) };
  }
}
