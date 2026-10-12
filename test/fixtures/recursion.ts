export function factorial(n: number): number {
  if (n <= 1) {
    return 1;
  }
  return n * factorial(n - 1);
}

export function ping(n: number): number {
  return n > 0 ? pong(n - 1) : 0;
}

export function pong(n: number): number {
  return ping(n);
}
