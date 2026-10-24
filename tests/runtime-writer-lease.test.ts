import { describe, expect, it } from "vitest";
import { acquireRuntimeWriterLease, getRuntimeLockManager, type RuntimeLock, type RuntimeLockManager } from "../src/platform/runtime-writer-lease";

class FakeRuntimeLockManager implements RuntimeLockManager {
  private readonly heldNames = new Set<string>();

  async request<T>(
    name: string,
    _options: { mode: "exclusive"; ifAvailable: true },
    callback: (lock: RuntimeLock | null) => T | PromiseLike<T>
  ): Promise<T> {
    if (this.heldNames.has(name)) return await callback(null);
    this.heldNames.add(name);
    try {
      return await callback({ name });
    } finally {
      this.heldNames.delete(name);
    }
  }
}

describe("app-profile runtime writer lease", () => {
  it("allows only one holder and admits the next instance after release", async () => {
    const manager = new FakeRuntimeLockManager();
    const first = await acquireRuntimeWriterLease(manager, "nyra:test:runtime");

    await expect(acquireRuntimeWriterLease(manager, "nyra:test:runtime", { busyWaitMs: 0 }))
      .rejects.toThrow(/Another Nyra window/);

    first.release();
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
    const next = await acquireRuntimeWriterLease(manager, "nyra:test:runtime");
    next.release();
  });

  it("fails closed when the host has no Web Locks implementation", async () => {
    await expect(acquireRuntimeWriterLease(null, "nyra:test:runtime"))
      .rejects.toThrow(/does not provide cross-window writer locks/);
  });

  it("validates lock names before requesting a platform lock", async () => {
    const manager = new FakeRuntimeLockManager();
    await expect(acquireRuntimeWriterLease(manager, ""))
      .rejects.toThrow(/Invalid Nyra runtime writer-lock name/);
  });
});

describe("host without Web Locks", () => {
  it("falls back to an in-process lock so a single window still syncs and double loads are refused", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true });
    try {
      const manager = getRuntimeLockManager();
      const first = await acquireRuntimeWriterLease(manager, "nyra:test:fallback");
      await expect(acquireRuntimeWriterLease(manager, "nyra:test:fallback", { busyWaitMs: 0 })).rejects.toThrow(/Another Nyra window/);
      first.release();
      (await acquireRuntimeWriterLease(manager, "nyra:test:fallback", { busyWaitMs: 200 })).release();
    } finally {
      if (original) Object.defineProperty(globalThis, "navigator", original);
      else delete (globalThis as { navigator?: unknown }).navigator;
    }
  });
});
