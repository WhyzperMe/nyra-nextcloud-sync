export type SyncOperationOwner = "autosync" | "manual" | "conflict-resolution";

/** One synchronous reservation owner across autosync preflight and user operations. */
export class SyncOperationGuard {
  private owner: SyncOperationOwner | null = null;
  private idleWaiters: Array<() => void> = [];

  currentOwner(): SyncOperationOwner | null { return this.owner; }
  isBusy(): boolean { return this.owner !== null; }
  isOwnedBy(owner: SyncOperationOwner): boolean { return this.owner === owner; }

  waitForIdle(): Promise<void> {
    if (this.owner === null) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  tryAcquire(owner: SyncOperationOwner): (() => void) | null {
    if (this.owner !== null) return null;
    this.owner = owner;
    let released = false;
    return () => {
      if (released) return;
      if (this.owner !== owner) throw new Error(`Sync operation reservation for '${owner}' was replaced before release.`);
      released = true;
      this.owner = null;
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const resolve of waiters) resolve();
    };
  }
}
