import { describe, expect, it } from "vitest";
import { ConsoleLogger } from "../src/diagnostics/logger";
import { ByteBudget } from "../src/local/byte-budget";
import { LocalPathPolicy } from "../src/local/path-policy";
import { LocalInventoryReconciler } from "../src/local/reconciler";
import { LocalInventoryScanner } from "../src/local/scanner";
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

describe("Local inventory", () => {
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
