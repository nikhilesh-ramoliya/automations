/**
 * Bounded concurrency helpers for web-only lead work.
 * Never use for LinkedIn — keep LI sessions sequential.
 */

/**
 * Map `items` through `fn` with at most `concurrency` in-flight calls.
 * Results preserve input order.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = items.length;
  if (n === 0) return [];
  const limit = Math.max(1, Math.min(Math.floor(concurrency) || 1, n));
  const results: R[] = new Array(n);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= n) return;
      results[i] = await fn(items[i]!, i);
    }
  };

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}
