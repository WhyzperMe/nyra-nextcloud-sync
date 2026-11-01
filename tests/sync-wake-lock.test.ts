import { describe, expect, it } from "vitest";
import { SyncWakeLock } from "../src/platform/sync-wake-lock";
import { SyncOperationGuard } from "../src/sync/operation-guard";

function fakeHost(options: { deny?: boolean } = {}) {
  const state = { requests: 0, releases: 0 };
  const host = {
    wakeLock: {
      async request(): Promise<{ release(): Promise<void> }> {
        state.requests += 1;
        if (options.deny) throw new Error("NotAllowedError");
        return { async release() { state.releases += 1; } };
      }
    }
  };
  return { host, state };
}

const flush = async (): Promise<void> => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };

describe("Sync wake lock", () => {
  it("holds the screen lock only while an operation is active", async () => {
    const { host, state } = fakeHost();
    const lock = new SyncWakeLock(() => host);
    const guard = new SyncOperationGuard((busy) => (busy ? lock.acquire() : lock.release()));

    const release = guard.tryAcquire("autosync");
    await flush();
    expect(state.requests).toBe(1);
    expect(lock.isHeld()).toBe(true);

    release?.();
    await flush();
    expect(state.releases).toBe(1);
    expect(lock.isHeld()).toBe(false);
  });

  it("releases a lock that was granted after the operation already finished", async () => {
    const { host, state } = fakeHost();
    const lock = new SyncWakeLock(() => host);
    lock.acquire();
    lock.release();
    await flush();
    expect(state.releases).toBe(1);
    expect(lock.isHeld()).toBe(false);
  });

  it("never throws when the lock is denied or unsupported and can be re-requested on resume", async () => {
    const denied = fakeHost({ deny: true });
    const lock = new SyncWakeLock(() => denied.host);
    lock.acquire();
    await flush();
    expect(lock.isHeld()).toBe(false);
    lock.reacquireIfWanted();
    await flush();
    expect(denied.state.requests).toBe(2);

    const unsupported = new SyncWakeLock(() => undefined);
    expect(() => { unsupported.acquire(); unsupported.release(); }).not.toThrow();
  });

  it("keeps the reservation intact when the busy hook throws", () => {
    const guard = new SyncOperationGuard(() => { throw new Error("hook failed"); });
    const release = guard.tryAcquire("manual");
    expect(guard.isBusy()).toBe(true);
    expect(() => release?.()).not.toThrow();
    expect(guard.isBusy()).toBe(false);
  });
});
