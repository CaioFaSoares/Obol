// Bounded waits around every network round trip. The timer only bounds the
// runner's own wait; it never changes a financial clock or retries a write.

export class DeadlineExceededError extends Error {
  readonly label: string;
  readonly timeoutMs: number;

  constructor(label: string, timeoutMs: number) {
    super(`${label} exceeded ${timeoutMs} ms`);
    this.name = 'DeadlineExceededError';
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => timeout.reject(new DeadlineExceededError(label, timeoutMs)),
    timeoutMs,
  );
  try {
    return await Promise.race([promise, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}
