export class TimeoutError extends Error {
  readonly operation: string;
  constructor(operation: string, ms: number) {
    super(`${operation} exceeded ${ms}ms timeout`);
    this.name = "TimeoutError";
    this.operation = operation;
  }
}

export async function withTimeout<T>(
  work: () => Promise<T>,
  ms: number,
  operation: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(operation, ms)), ms);
  });
  try {
    return (await Promise.race([work(), timeout])) as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
