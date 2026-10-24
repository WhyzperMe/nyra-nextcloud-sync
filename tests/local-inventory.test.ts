import { describe, expect, it } from "vitest";
import { ConsoleLogger } from "../src/diagnostics/logger";
import { ByteBudget } from "../src/local/byte-budget";
import { LocalPathPolicy } from "../src/local/path-policy";
import { LocalInventoryReconciler } from "../src/local/reconciler";
import { LocalInventoryScanner } from "../src/local/scanner";
import { LocalInventoryService } from "../src/local/service";
import { LocalMutationLedger } from "../src/local/mutation-ledger";
import type { LocalFileMetadata, LocalFullScanResult, LocalInventoryEntry } from "../src/local/types";
import type { LocalFileSource } from "../src/local/source";
import { DurableStateStore } from "../src/state/durable/store";
import { MemoryStateBackend } from "./helpers/memory-backend";

class MemoryFileSource implements LocalFileSource {
  readonly files = new Map<string, { text: string; ctimeMs: number; mtimeMs: number }>();
  readHook: ((path: string) => void) | null = null;

  put(path: string, text: string, mtimeMs = 1000): void {
    this.files.set(path, { text, ctimeMs: mtimeMs, mtimeMs });
  }

  delete(path: string): void {
    this.files.delete(path);
  }

  async listFiles(): Promise<LocalFileMetadata[]> {
    return [...this.files].map(([path, value]) => ({
      path,
      size: new TextEncoder().encode(value.text).byteLength,
      ctimeMs: value.ctimeMs,
      mtimeMs: value.mtimeMs
    }));
  }

  async stat(path: string): Promise<LocalFileMetadata | null> {
    const value = this.files.get(path);
    if (!value) return null;
    return {
      path,
      size: new TextEncoder().encode(value.text).byteLength,
      ctimeMs: value.ctimeMs,
      mtimeMs: value.mtimeMs
    };
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    this.readHook?.(path);
    const value = this.files.get(path);
    if (!value) throw new Error("missing file");
    return new TextEncoder().encode(value.text).buffer;
  }
}

function full(entries: LocalInventoryEntry[], complete = true): LocalFullScanResult {
  return {
    kind: "full",
    entries,
    complete,
    issues: complete ? [] : [{ path: "<vault>", code: "concurrent-change", message: "test race" }],
    oversized: [],
    hashedBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    renameCandidates: [],
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(1).toISOString()
  };
}

describe("Local inventory local inventory", () => {
  it("invalidates complete facts when a watcher reconciliation fails", async () => {
    const logger = new ConsoleLogger();
    const store = await DurableStateStore.open(new MemoryStateBackend(), logger);
    const scanner = {
      async scanFull() { return full([]); },
      async scanPaths() { throw new Error("injected inventory failure"); }
    } as unknown as LocalInventoryScanner;
    const service = new LocalInventoryService(scanner, store, new LocalMutationLedger(), logger);
    await service.scanFull();
    expect(service.summary().lastScanComplete).toBe(true);
    await expect(service.applyChangeBatch({ sequence: 1, paths: ["Note.md"], renames: [], requiresFullScan: false })).rejects.toThrow("injected inventory failure");
    expect(service.summary().lastScanComplete).toBe(false);
    expect(service.summary().status).toBe("degraded");
  });

  it("hashes a stable vault while excluding only reserved roots", async () => {
    const source = new MemoryFileSource();
    source.put("Note.md", "alpha");
    source.put(".obsidian/app.json", "settings");
    source.put(".obsidian/plugins/nyra-nextcloud-sync/state-v2/wal/x.json", "private");
    const scanner = new LocalInventoryScanner(
      source,
      new LocalPathPolicy([".trash", ".obsidian/plugins/nyra-nextcloud-sync"]),
      { concurrency: 2, maxInFlightBytes: 1024 * 1024, stableReadAttempts: 2, fullScanRounds: 2, retryDelayMs: 1 }
    );

    const result = await scanner.scanFull();
    expect(result.complete).toBe(true);
    expect(result.entries.map((entry) => entry.path)).toEqual([".obsidian/app.json", "Note.md"]);
    expect(result.entries.every((entry) => /^[a-f0-9]{64}$/.test(entry.contentHash))).toBe(true);
  });

  it("never reports a raced read as a stable complete observation", async () => {
    const source = new MemoryFileSource();
    source.put("A.md", "one", 1000);
    let mutated = false;
    source.readHook = () => {
      if (!mutated) {
        mutated = true;
        source.put("A.md", "two", 2000);
      }
    };
    const scanner = new LocalInventoryScanner(source, new LocalPathPolicy(), {
      concurrency: 1,
      maxInFlightBytes: 1024 * 1024,
      stableReadAttempts: 2,
      fullScanRounds: 2,
      retryDelayMs: 1
    });
    const result = await scanner.scanFull();
    expect(result.complete).toBe(true);
    expect(result.entries[0]?.size).toBe(3);
  });

  it("skips a file above the whole-buffer limit without reading it and without making the scan incomplete", async () => {
    const source = new MemoryFileSource();
    source.put("large.bin", "0123456789");
    source.put("small.md", "ok");
    let reads = 0;
    source.readHook = () => { reads += 1; };
    const policy = new LocalPathPolicy();
    const scanner = new LocalInventoryScanner(source, policy, {
      concurrency: 1,
      maxInFlightBytes: 8,
      maxFileBytes: 4,
      stableReadAttempts: 1,
      fullScanRounds: 1,
      retryDelayMs: 1
    });
    const result = await scanner.scanFull();
    expect(result.complete).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.entries.map((entry) => entry.path)).toEqual(["small.md"]);
    expect(reads).toBe(1);
    expect(result.oversized).toEqual([{
      path: "large.bin",
      reasonCode: "LOCAL_FILE_TOO_LARGE_FOR_SAFE_PLATFORM_READ",
      actualSizeBytes: 10,
      maxSafeReadBytes: 4
    }]);
    // Dormant for sync decisions, but still part of the static vault scope.
    expect(policy.isIncluded("large.bin")).toBe(false);
    expect(policy.isInScope("large.bin")).toBe(true);
    expect(policy.isIncluded("small.md")).toBe(true);
  });

  it("surfaces bounded platform-limit diagnostics, keeps the scan complete and never removes the file's record", async () => {
    const source = new MemoryFileSource();
    source.put("attachments/Large.bin", "0123456789");
    const backend = new MemoryStateBackend();
    const store = await DurableStateStore.open(backend, new ConsoleLogger());
    const policy = new LocalPathPolicy();
    const scanner = new LocalInventoryScanner(source, policy, {
      concurrency: 1,
      maxInFlightBytes: 64,
      maxFileBytes: 4,
      stableReadAttempts: 1,
      fullScanRounds: 1,
      retryDelayMs: 1
    });
    const service = new LocalInventoryService(scanner, store, new LocalMutationLedger(), new ConsoleLogger(), policy);

    const outcome = await service.scanFull("oversized-file-diagnostic-test");
    const summary = service.summary();
    expect(outcome.scan.complete).toBe(true);
    expect(summary.lastScanComplete).toBe(true);
    expect(summary.readBlocks).toEqual([{
      path: "attachments/Large.bin",
      reasonCode: "LOCAL_FILE_TOO_LARGE_FOR_SAFE_PLATFORM_READ",
      actualSizeBytes: 10,
      maxSafeReadBytes: 4
    }]);
    expect(Object.keys(store.getState().files)).toEqual([]);
  });

  it("does not create or delete identity from an incomplete full scan", async () => {
    const backend = new MemoryStateBackend();
    const store = await DurableStateStore.open(backend, new ConsoleLogger());
    const reconciler = new LocalInventoryReconciler(store);
    const entry: LocalInventoryEntry = { path: "A.md", size: 1, mtimeMs: 1, ctimeMs: 1, contentHash: "a".repeat(64) };

    const first = await reconciler.applyFullScan(full([entry]), { exactRenames: [], allowNewRecords: true });
    expect(first.created).toBe(1);
    const id = Object.values(store.getState().files)[0]?.entryId;
    expect(id).toBeTruthy();

    const incompleteNew: LocalInventoryEntry = { ...entry, path: "B.md", contentHash: "b".repeat(64) };
    const second = await reconciler.applyFullScan(full([incompleteNew], false), { exactRenames: [], allowNewRecords: true });
    expect(second.deferredCreates).toBe(1);
    expect(Object.values(store.getState().files).map((record) => record.path)).toEqual(["A.md"]);
  });

  it("preserves file identity across an exact folder rename event", async () => {
    const backend = new MemoryStateBackend();
    const store = await DurableStateStore.open(backend, new ConsoleLogger());
    const reconciler = new LocalInventoryReconciler(store);
    const oldEntry: LocalInventoryEntry = { path: "Old/A.md", size: 1, mtimeMs: 1, ctimeMs: 1, contentHash: "c".repeat(64) };
    await reconciler.applyFullScan(full([oldEntry]), { exactRenames: [], allowNewRecords: true });
    const before = Object.values(store.getState().files)[0];

    const newEntry = { ...oldEntry, path: "New/A.md", mtimeMs: 2, ctimeMs: 2 };
    const stats = await reconciler.applyFullScan(full([newEntry]), {
      allowNewRecords: true,
      exactRenames: [{ oldPath: "Old", newPath: "New", kind: "folder", source: "vault-event", confidence: "exact" }]
    });
    const after = Object.values(store.getState().files)[0];
    expect(stats.renamed).toBe(1);
    expect(after?.entryId).toBe(before?.entryId);
    expect(after?.path).toBe("New/A.md");
  });

  it("serializes weighted reads without exceeding the byte budget", async () => {
    const budget = new ByteBudget(10);
    const releaseA = await budget.acquire(8);
    let acquiredB = false;
    const pending = budget.acquire(8).then((release) => {
      acquiredB = true;
      release();
    });
    await Promise.resolve();
    expect(acquiredB).toBe(false);
    releaseA();
    await pending;
    expect(acquiredB).toBe(true);
  });
});

describe("metadata-trusting scans", () => {
  const options = { concurrency: 1, maxInFlightBytes: 1024, stableReadAttempts: 1, fullScanRounds: 1, retryDelayMs: 1 };

  it("reuses hashes of stable, unchanged files and rereads changed, racy or fully verified ones", async () => {
    const source = new MemoryFileSource();
    const reads: string[] = [];
    source.readHook = (path) => reads.push(path);
    source.put("old.md", "old", 1000);                 // modified long before it is first hashed
    source.put("racy.md", "racy", Date.now());          // modified just before it is hashed
    source.put("edit.md", "before", 1000);
    const scanner = new LocalInventoryScanner(source, new LocalPathPolicy(), options);

    await scanner.scanFull();
    expect(reads.sort()).toEqual(["edit.md", "old.md", "racy.md"]);

    reads.length = 0;
    source.put("edit.md", "after!", 2000);              // new size and mtime
    const trusted = await scanner.scanFull([], undefined, { trustMetadata: true });
    expect(trusted.complete).toBe(true);
    expect(reads.sort()).toEqual(["edit.md", "racy.md"]); // old.md came from the cache
    expect(trusted.entries.find((entry) => entry.path === "old.md")?.contentHash).toMatch(/^[a-f0-9]{64}$/);

    reads.length = 0;
    await scanner.scanFull([], undefined, { trustMetadata: false });
    expect(reads.sort()).toEqual(["edit.md", "old.md", "racy.md"]); // verified scans read everything
  });

  it("forgets deleted files and never serves a stale hash for a changed one", async () => {
    const source = new MemoryFileSource();
    source.put("a.md", "one", 1000);
    const scanner = new LocalInventoryScanner(source, new LocalPathPolicy(), options);
    const first = await scanner.scanFull();
    source.put("a.md", "three", 1000);                  // same mtime, different size: must be rehashed
    const second = await scanner.scanFull([], undefined, { trustMetadata: true });
    expect(second.entries[0]?.contentHash).not.toBe(first.entries[0]?.contentHash);
    source.delete("a.md");
    expect((await scanner.scanFull([], undefined, { trustMetadata: true })).entries).toEqual([]);
    source.put("a.md", "one", 1000);                    // reappears: cache entry was dropped, so it is read again
    let reads = 0;
    source.readHook = () => { reads += 1; };
    await scanner.scanFull([], undefined, { trustMetadata: true });
    expect(reads).toBe(1);
  });
});
