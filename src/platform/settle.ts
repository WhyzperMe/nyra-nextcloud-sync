const DEFAULT_DELAYS_MS = [25, 75, 200, 500];

/**
 * Phone storage can answer a read right after a write with stale, short or re-encoded data. A check that
 * fails is repeated with growing pauses before it is believed; a check that passes returns at once, so
 * healthy devices pay nothing. A check that throws counts as a failed attempt.
 */
export async function settles(check: () => Promise<boolean>, delaysMs: readonly number[] = DEFAULT_DELAYS_MS): Promise<boolean> {
  for (let attempt = 0; ; attempt += 1) {
    let ok = false;
    try { ok = await check(); } catch { ok = false; }
    if (ok) return true;
    const delay = delaysMs[attempt];
    if (delay === undefined) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }
}

/** Whether two JSON texts describe the same value, whatever whitespace or escaping the storage layer chose. */
export function sameJson(a: string, b: string): boolean {
  if (a === b) return true;
  try { return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b)); }
  catch { return false; }
}
