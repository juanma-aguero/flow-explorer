declare function work(n?: number): number;
declare function risky(): void;
declare function cleanup(): void;

export function sequence(a: number): number {
  const x = work(a);
  let y = x + 1;
  y = work(y);
  work();
  return y;
}

export function branching(flag: boolean): string {
  if (flag) {
    work(1);
  } else {
    work(2);
  }
  return 'done';
}

export function ifWithoutElse(flag: boolean): void {
  if (flag) work(1);
  work(2);
}

export function elseIfChain(n: number): string {
  if (n < 0) return 'neg';
  else if (n === 0) return 'zero';
  else return 'pos';
}

export function nestedFunctionsDoNotRun(items: number[]): number[] {
  const handler = () => work(99);
  function helper() {
    return work(98);
  }
  return items.map((i) => work(i));
}

export async function tryCatch(): Promise<number> {
  try {
    const v = await Promise.resolve(work(1));
    risky();
    return v;
  } catch (e) {
    work(2);
    throw e;
  } finally {
    cleanup();
  }
}

export function looping(items: number[]): number {
  let sum = 0;
  for (const i of items) {
    sum += work(i);
  }
  return sum;
}

export function switching(kind: string): number {
  switch (kind) {
    case 'a':
      work(1);
      break;
    case 'b':
    case 'c':
      work(2);
    default:
      work(3);
  }
  return 0;
}

export const arrowExpr = (n: number) => work(n);

export class Service {
  private n = 0;
  run(): number {
    this.n = this.step();
    return this.n;
  }
  step(): number {
    return work(this.n);
  }
}

export function empty(): void {}

export function emptyIf(flag: boolean): void {
  if (flag) {
  }
  work(1);
}
