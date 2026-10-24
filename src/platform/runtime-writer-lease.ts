export interface RuntimeLock {
  readonly name: string;
}

export interface RuntimeLockManager {
  request<T>(
    name: string,
    options: { mode: "exclusive"; ifAvailable: true },
    callback: (lock: RuntimeLock | null) => T | PromiseLike<T>
  ): Promise<T>;
}

export interface RuntimeWriterLease {
  release(): void;
}

export interface RuntimeWriterLeaseOptions {
  /** A short bounded wait lets an instance finish a just-started unload. */
  busyWaitMs?: number;
  retryIntervalMs?: number;
}

/**
 * The durable WAL and apply-recovery journal have one writer per Obsidian app
 * profile. Web Locks coordinates plugin instances across windows on desktop
 * and mobile; unsupported hosts fail closed rather than risk duplicate WAL
 * sequence publication.
 */
export async function acquireRuntimeWriterLease(
  manager: RuntimeLockManager | null | undefined,
  name: string,
  options: RuntimeWriterLeaseOptions = {}
): Promise<RuntimeWriterLease> {
  if (!manager) {
    throw new Error("This Obsidian host does not provide cross-window writer locks. Nyra paused sync to protect its recovery state.");
  }
  if (!name || name.length > 256) throw new Error("Invalid Nyra runtime writer-lock name.");

  const busyWaitMs = options.busyWaitMs ?? 2_000;
  const retryIntervalMs = options.retryIntervalMs ?? 100;
  if (!Number.isSafeInteger(busyWaitMs) || busyWaitMs < 0 || !Number.isSafeInteger(retryIntervalMs) || retryIntervalMs <= 0) {
    throw new Error("Runtime writer-lock retry limits must be non-negative safe integers.");
  }
  const startedAt = Date.now();
  while (true) {
    const lease = await tryAcquire(manager, name);
    if (lease) return lease;
    const elapsed = Date.now() - startedAt;
    if (elapsed >= busyWaitMs) {
      throw new Error("Another Nyra window is using this Obsidian profile. Sync is paused here to protect its recovery state.");
    }
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, Math.min(retryIntervalMs, busyWaitMs - elapsed)));
  }
}

async function tryAcquire(manager: RuntimeLockManager, name: string): Promise<RuntimeWriterLease | null> {
  let settleReady!: (lease: RuntimeWriterLease | null) => void;
  let rejectReady!: (error: unknown) => void;
  let settled = false;
  const ready = new Promise<RuntimeWriterLease | null>((resolve, reject) => {
    settleReady = resolve;
    rejectReady = reject;
  });
  let releaseLock: (() => void) | null = null;
  const held = new Promise<void>((resolve) => {
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      resolve();
    };
    releaseLock = release;
  });
  const resolveReady = (lease: RuntimeWriterLease | null): void => {
    if (settled) return;
    settled = true;
    settleReady(lease);
  };

  const request = manager.request(name, { mode: "exclusive", ifAvailable: true }, async (lock) => {
    if (!lock) {
      resolveReady(null);
      return;
    }
    resolveReady({ release: () => releaseLock?.() });
    await held;
  });
  void request.catch((error: unknown) => {
    if (settled) return;
    settled = true;
    rejectReady(error);
  });
  return await ready;
}

/**
 * Cross-window Web Locks when the host has them. Hosts without the API (older
 * mobile WebViews) run a single Obsidian window, so an in-process lock still
 * guards against a plugin being loaded twice in that one JavaScript context.
 */
export function getRuntimeLockManager(): RuntimeLockManager {
  try {
    const locks = globalThis.navigator?.locks;
    if (locks) return locks;
  } catch {
    // Fall through to the in-process manager.
  }
  return inProcessLockManager;
}

const heldInProcess = new Set<string>();
const inProcessLockManager: RuntimeLockManager = {
  async request<T>(name: string, _options: { mode: "exclusive"; ifAvailable: true }, callback: (lock: RuntimeLock | null) => T | PromiseLike<T>): Promise<T> {
    if (heldInProcess.has(name)) return await callback(null);
    heldInProcess.add(name);
    try { return await callback({ name }); }
    finally { heldInProcess.delete(name); }
  }
};
