import { describe, expect, it } from "vitest";
import { LocalChangeBuffer } from "../src/local/change-buffer";

describe("local event coalescing flush", () => {
  it("awaits the active drain and any events that arrive during it", async () => {
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const batches: string[][] = [];
    const buffer = new LocalChangeBuffer(async (batch) => {
      batches.push(batch.paths);
      if (batch.paths.includes("A.md")) {
        markFirstStarted();
        await firstGate;
      }
    });
    buffer.notePath("A.md");
    const first = buffer.flushNow();
    await firstStarted;
    buffer.notePath("B.md");
    let secondDone = false;
    const second = buffer.flushNow().then(() => { secondDone = true; });
    await Promise.resolve();
    expect(secondDone).toBe(false);
    releaseFirst();
    await Promise.all([first, second]);
    expect(batches).toEqual([["A.md"], ["B.md"]]);
    expect(secondDone).toBe(true);
    buffer.close();
  });
});
