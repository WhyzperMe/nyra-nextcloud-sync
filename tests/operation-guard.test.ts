import { describe, expect, it } from "vitest";
import { SyncOperationGuard } from "../src/sync/operation-guard";

describe("sync operation shutdown barrier", () => {
  it("waits until the active owner releases its reservation", async () => {
    const guard = new SyncOperationGuard();
    const release = guard.tryAcquire("manual");
    expect(release).not.toBeNull();

    let drained = false;
    const waiting = guard.waitForIdle().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);

    release?.();
    await waiting;
    expect(drained).toBe(true);
  });

  it("resolves an idle wait immediately when no operation owns the guard", async () => {
    await expect(new SyncOperationGuard().waitForIdle()).resolves.toBeUndefined();
  });
});
