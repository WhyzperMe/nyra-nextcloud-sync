interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener?(type: "release", listener: () => void): void;
}

interface WakeLockHost {
  wakeLock?: { request(type: "screen"): Promise<WakeLockSentinelLike> };
}

/**
 * Holds a screen wake lock only while a sync operation is running. Mobile systems freeze the web view
 * shortly after the screen turns off, which can cut a transfer or a state write in half; keeping the
 * screen on for the few seconds a cycle takes avoids that. The lock is best effort and never throws.
 */
export class SyncWakeLock {
  private sentinel: WakeLockSentinelLike | null = null;
  private wanted = false;

  constructor(private readonly host: () => WakeLockHost | undefined = () => (typeof navigator === "undefined" ? undefined : navigator as WakeLockHost)) {}

  acquire(): void {
    this.wanted = true;
    void this.ensure();
  }

  release(): void {
    this.wanted = false;
    const sentinel = this.sentinel;
    this.sentinel = null;
    if (sentinel) void sentinel.release().catch(() => undefined);
  }

  /** The lock is dropped by the system when the page is hidden; take it again when it becomes visible. */
  reacquireIfWanted(): void {
    if (this.wanted && !this.sentinel) void this.ensure();
  }

  isHeld(): boolean { return this.sentinel !== null; }

  private async ensure(): Promise<void> {
    if (this.sentinel) return;
    const api = this.host()?.wakeLock;
    if (!api) return;
    try {
      const sentinel = await api.request("screen");
      if (!this.wanted) {
        void sentinel.release().catch(() => undefined);
        return;
      }
      this.sentinel = sentinel;
      sentinel.addEventListener?.("release", () => { if (this.sentinel === sentinel) this.sentinel = null; });
    } catch {
      // Denied (battery saver, hidden page, unsupported web view): sync continues without the lock.
    }
  }
}
