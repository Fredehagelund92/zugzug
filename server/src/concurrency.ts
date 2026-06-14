/* concurrency.ts — bounded promise-pool helper. Used by PR3's webhook
   dispatcher to fan out outbound HTTP calls without spawning unbounded
   concurrency. We do NOT pull in p-map / promise-pool to keep the
   dependency footprint minimal.

   Errors thrown by a work item resolve that slot to `null` in the result —
   the wrapper itself never rejects. Caller filters with .filter(Boolean) or
   keeps positional `null`s for diagnostic correlation. */

export async function runWithConcurrency<T, R>(
  items: ReadonlyArray<T>,
  max: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Array<R | null>> {
  const n = items.length;
  if (n === 0) return [];
  const cap = Math.max(1, Math.min(max, n));
  const results: Array<R | null> = new Array(n).fill(null);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= n) return;
      try {
        results[i] = await fn(items[i]!, i);
      } catch {
        results[i] = null;
      }
    }
  }

  const workers: Promise<void>[] = [];
  for (let w = 0; w < cap; w++) workers.push(worker());
  await Promise.all(workers);
  return results;
}
