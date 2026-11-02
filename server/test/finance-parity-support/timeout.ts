// Finite wall-clock bounds for every synchronous-PocketBase round trip. The
// timer only bounds the runner's wait; it never changes a financial clock.

export class CommandTimeoutError extends Error {
  readonly label: string;
  readonly timeoutMs: number;

  constructor(label: string, timeoutMs: number) {
    super(`${label} exceeded ${timeoutMs} ms`);
    this.name = 'CommandTimeoutError';
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => timeout.reject(new CommandTimeoutError(label, timeoutMs)),
    timeoutMs,
  );
  return Promise.race([promise, timeout.promise]).finally(() => clearTimeout(timer));
}
