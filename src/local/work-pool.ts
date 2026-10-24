export async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
    throw new Error("Concurrency must be a positive safe integer.");
  }
  const output = new Array<R>(values.length);
  let cursor = 0;
  let failed = false;
  const failures: Array<{ index: number; error: unknown }> = [];

  const runners = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (!failed) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      try {
        const value = values[index];
        if (value === undefined) throw new Error("Concurrent work queue index invariant failed.");
        output[index] = await worker(value, index);
      } catch (error) {
        failed = true;
        failures.push({ index, error });
      }
    }
  });

  await Promise.all(runners);
  // Await already-started reads before releasing scan ownership. Promise.all's
  // early rejection would leave workers running into the next scan or shutdown.
  if (failed) throw failures.sort((left, right) => left.index - right.index)[0]!.error;
  return output;
}
