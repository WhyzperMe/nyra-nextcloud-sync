import { describe, expect, it } from "vitest";
import { mapConcurrent } from "../src/local/work-pool";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => { resolve = yes; });
  return { promise, resolve };
}

describe("Concurrent scan worker ownership", () => {
  it("drains active workers after failure and stops starting queued work", async () => {
    const first = deferred(); const second = deferred();
    const started: number[] = []; const finished: number[] = [];
    let settled = false;
    const pending = mapConcurrent([0, 1, 2, 3], 2, async (value) => {
      started.push(value);
      if (value === 0) { await first.promise; throw new Error("first failed"); }
      await second.promise; finished.push(value); return value;
    });
    const outcome = pending.then(() => { settled = true; }, (error: unknown) => { settled = true; return error; });
    expect(started).toEqual([0, 1]); first.resolve();
    await Promise.resolve(); await Promise.resolve();
    expect(settled).toBe(false); expect(started).toEqual([0, 1]);
    second.resolve(); const error = await outcome;
    expect(error instanceof Error ? error.message : "unknown").toBe("first failed");
    expect(finished).toEqual([1]); expect(started).toEqual([0, 1]);
  });

  it("reports the lowest-index active failure even when later work fails first", async () => {
    const gate = deferred();
    const pending = mapConcurrent([0, 1], 2, async (value) => {
      if (value === 0) { await gate.promise; throw new Error("earlier input"); }
      throw new Error("later input");
    });
    gate.resolve(); await expect(pending).rejects.toThrow(/earlier input/);
  });

  it("preserves ordered successful results and handles an empty input", async () => {
    expect(await mapConcurrent([3, 2, 1], 2, async (value) => value * 2)).toEqual([6, 4, 2]);
    expect(await mapConcurrent([], 2, async () => 1)).toEqual([]);
  });
});
