import { coalesceExactRenames } from "./rename-hints";
import type { LocalChangeBatch, LocalRenameHint } from "./types";

export interface LocalChangeBufferOptions {
  debounceMs: number;
  maxLatencyMs: number;
}

const DEFAULT_OPTIONS: LocalChangeBufferOptions = {
  debounceMs: 300,
  maxLatencyMs: 2000
};

/** Debounces noisy Vault events into serialized rescan requests. Events are hints, never state. */
export class LocalChangeBuffer {
  private readonly options: LocalChangeBufferOptions;
  private readonly paths = new Set<string>();
  private readonly renames: LocalRenameHint[] = [];
  private requiresFullScan = false;
  private sequence = 0;
  private debounceTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private maxTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private flushing = false;
  private flushPromise: Promise<void> | null = null;
  private flushAgain = false;
  private closed = false;

  constructor(
    private readonly onBatch: (batch: LocalChangeBatch) => Promise<void>,
    options: Partial<LocalChangeBufferOptions> = {}
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    if (!Number.isSafeInteger(this.options.debounceMs) || this.options.debounceMs <= 0) throw new Error("debounceMs must be positive.");
    if (!Number.isSafeInteger(this.options.maxLatencyMs) || this.options.maxLatencyMs < this.options.debounceMs) {
      throw new Error("maxLatencyMs must be an integer >= debounceMs.");
    }
  }

  notePath(path: string): void {
    if (this.closed) return;
    this.paths.add(path);
    this.schedule();
  }

  noteRename(hint: LocalRenameHint): void {
    if (this.closed) return;
    this.renames.push({ ...hint });
    this.paths.add(hint.oldPath);
    this.paths.add(hint.newPath);
    this.schedule();
  }

  noteTreeChange(path?: string): void {
    if (this.closed) return;
    if (path) this.paths.add(path);
    this.requiresFullScan = true;
    this.schedule();
  }

  async flushNow(): Promise<void> {
    if (this.closed) return;
    if (this.flushing) {
      if (this.hasPending()) this.flushAgain = true;
      await this.flushPromise;
      return;
    }
    if (!this.hasPending()) return;
    this.clearTimers();
    this.flushing = true;
    try {
      this.flushPromise = Promise.resolve().then(async () => {
        do {
          this.flushAgain = false;
          if (!this.hasPending()) break;
          const batch = this.takeBatch();
          await this.onBatch(batch);
        } while (this.flushAgain || this.hasPending());
      });
      await this.flushPromise;
    } finally {
      this.flushing = false;
      this.flushPromise = null;
      if (!this.closed && this.hasPending()) this.schedule();
    }
  }

  close(): void {
    this.closed = true;
    this.clearTimers();
    this.paths.clear();
    this.renames.length = 0;
    this.requiresFullScan = false;
  }

  private schedule(): void {
    if (this.closed) return;
    if (this.debounceTimer !== null) globalThis.clearTimeout(this.debounceTimer);
    this.debounceTimer = globalThis.setTimeout(() => {
      this.debounceTimer = null;
      void this.flushNow();
    }, this.options.debounceMs);
    if (this.maxTimer === null) {
      this.maxTimer = globalThis.setTimeout(() => {
        this.maxTimer = null;
        void this.flushNow();
      }, this.options.maxLatencyMs);
    }
  }

  private takeBatch(): LocalChangeBatch {
    if (this.sequence >= Number.MAX_SAFE_INTEGER) this.sequence = 0;
    this.sequence += 1;
    const batch: LocalChangeBatch = {
      sequence: this.sequence,
      paths: [...this.paths].sort(),
      renames: coalesceExactRenames(this.renames),
      requiresFullScan: this.requiresFullScan
    };
    this.paths.clear();
    this.renames.length = 0;
    this.requiresFullScan = false;
    this.clearTimers();
    return batch;
  }

  private hasPending(): boolean {
    return this.paths.size > 0 || this.renames.length > 0 || this.requiresFullScan;
  }

  private clearTimers(): void {
    if (this.debounceTimer !== null) globalThis.clearTimeout(this.debounceTimer);
    if (this.maxTimer !== null) globalThis.clearTimeout(this.maxTimer);
    this.debounceTimer = null;
    this.maxTimer = null;
  }
}
