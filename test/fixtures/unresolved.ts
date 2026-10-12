interface Gateway {
  charge(n: number): string;
}

declare const handlers: Record<string, () => void>;
declare function wrap<T>(fn: T): T;
const wrapped = wrap(() => 1);

export function callsEverything(gateway: Gateway, key: string): void {
  gateway.charge(1);
  JSON.stringify({});
  handlers[key]();
  wrapped();
  notDefinedAnywhere();
}

declare function notDefinedAnywhere(): void;

export function callsLocal(): number {
  return local();
}

function local(): number {
  return 1;
}

export class WithoutCtor {}
export function constructs(): WithoutCtor {
  return new WithoutCtor();
}

function other(): number {
  return 2;
}

export function multi(): number {
  return local() + other();
}
