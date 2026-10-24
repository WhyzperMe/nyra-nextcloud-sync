import { describe, expect, it } from "vitest";
import type { Logger } from "../src/diagnostics/logger";
import { TransactionalSyncExecutor } from "../src/execution/executor";
import type { LocalTransactionalMutator, PreparedLocalSnapshot } from "../src/execution/local-mutator";
import type { RemoteTransactionalMutator, RemoteTransferResult } from "../src/execution/remote-mutator";
import { SyncPlanner } from "../src/planner/planner";
import { sha256Hex } from "../src/state/durable/crypto";
import { DurableStateStore } from "../src/state/durable/store";
import type { TransferTuning } from "../src/transfer/types";
import { MemoryStateBackend } from "./helpers/memory-backend";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const tuning: TransferTuning = {
  chunkUploadThresholdBytes: 5 * 1024 * 1024,
  uploadChunkBytes: 5 * 1024 * 1024,
  downloadRangeChunkBytes: 1024 * 1024,
  maxWholeDownloadBytes: 5 * 1024 * 1024
};

describe("Transactional executor regression", () => {
  it("does not recreate remote parent folders for a local create whose source vanished", async () => {
    const store = await DurableStateStore.open(new MemoryStateBackend(), logger);
    const blob = await store.putTextBlob("deleted before execution");
    await store.transact("seed-vanished-create", (tx) => tx.putFile({
      entryId: "file_vanished", path: "Deleted/New.md", baseline: null,
      local: { path: "Deleted/New.md", contentHash: blob.hash, size: blob.size, mtimeMs: 1 },
      remote: null, status: "local-dirty"
    }));
    let createdParents = false;
    const local = { async prepareSnapshot() { throw new Error("source missing"); } } as unknown as LocalTransactionalMutator;
    const remote = { async ensureParentDirectories() { createdParents = true; } } as unknown as RemoteTransactionalMutator;
    const executor = new TransactionalSyncExecutor(store, local, remote, "https://cloud.test/dav/", "Vault", tuning, logger);
    await expect(executor.execute(await new SyncPlanner().build(store.getState()), { allowDestructive: false, allowMerge: false, maxOperations: 20 })).rejects.toThrow("source missing");
    expect(createdParents).toBe(false);
  });

  it("uploads from a fenced snapshot and establishes an immutable chunk-written baseline", async () => {
    const store = await DurableStateStore.open(new MemoryStateBackend(), logger);
    const bytes = new TextEncoder().encode("regression\n").buffer;
    const hash = await sha256Hex(bytes);
    await store.transact("seed-local-create", (tx) => tx.putFile({
      entryId: "file_regression",
      path: "Notes/A.md",
      baseline: null,
      local: { path: "Notes/A.md", contentHash: hash, size: bytes.byteLength, mtimeMs: 1 },
      remote: null,
      status: "local-dirty"
    }));
    const plan = await new SyncPlanner().build(store.getState());

    const local = {
      async prepareSnapshot(path: string, expected: string): Promise<PreparedLocalSnapshot> {
        expect(path).toBe("Notes/A.md");
        expect(expected).toBe(hash);
        return snapshot(path, bytes, hash);
      }
    } as unknown as LocalTransactionalMutator;

    const remoteState = {
      path: "Notes/A.md", contentHash: hash, reportedSha256: null, etag: '"etag-1"', fileId: "501", size: bytes.byteLength, mtimeMs: 2
    };
    const liveProgress: Array<{ transferred: number; total: number }> = [];
    const remote = {
      async ensureParentDirectories() {},
      async uploadCreateFromSnapshot(_url: string, _path: string, _snapshot: PreparedLocalSnapshot, onProgress?: (transferred: number, total: number) => void): Promise<RemoteTransferResult> {
        onProgress?.(5, bytes.byteLength);
        return { contentHash: hash, remote: remoteState, chunked: false, resumed: false };
      }
    } as unknown as RemoteTransactionalMutator;

    let executor!: TransactionalSyncExecutor;
    executor = new TransactionalSyncExecutor(
      store, local, remote, "https://cloud.example.test/remote.php/dav/files/u/", "Obsidian", tuning, logger,
      () => liveProgress.push({ transferred: executor.summary().activeTransferBytes, total: executor.summary().activeTransferTotalBytes ?? -1 })
    );
    const report = await executor.execute(plan, { allowDestructive: false, allowMerge: false, maxOperations: 20 });
    expect(report.failed).toBe(0);
    expect(report.completed).toBe(2);
    expect(report.bytesProcessed).toBe(bytes.byteLength);
    expect(liveProgress).toContainEqual({ transferred: 5, total: bytes.byteLength });
    const record = store.getState().files.file_regression;
    expect(record?.baseline?.blobHash).toBe(hash);
    expect(record?.baseline?.remoteFileId).toBe("501");
    expect(record?.remote?.contentHash).toBe(hash);
    expect(record?.status).toBe("clean");
    expect((await store.getBlob(hash)).byteLength).toBe(bytes.byteLength);
  });

  it("refuses stale plans before any physical operation", async () => {
    const store = await DurableStateStore.open(new MemoryStateBackend(), logger);
    const plan = await new SyncPlanner().build(store.getState());
    await store.transact("advance-state", (tx) => tx.putTombstone({
      tombstoneId: "tomb_regression",
      entryId: "file_none000",
      previousPath: "x.md",
      deletedSide: "local",
      previousBlobHash: null,
      previousRemoteFileId: null,
      createdAt: new Date().toISOString()
    }));
    const executor = new TransactionalSyncExecutor(
      store, {} as LocalTransactionalMutator, {} as RemoteTransactionalMutator,
      "https://cloud.example.test/", "Obsidian", tuning, logger
    );
    await expect(executor.execute(plan, { allowDestructive: false, allowMerge: false, maxOperations: 20 })).rejects.toThrow(/stale/i);
  });
});

function snapshot(path: string, bytes: ArrayBuffer, hash: string): PreparedLocalSnapshot {
  return {
    snapshotId: "snapshot-test",
    path,
    contentHash: hash,
    size: bytes.byteLength,
    mtimeMs: 1,
    chunkSize: Math.max(1, bytes.byteLength),
    chunkCount: 1,
    async readChunk(index: number) { if (index !== 0) throw new Error("bad index"); return bytes.slice(0); },
    async *chunks() { yield bytes.slice(0); },
    async assertSourceUnchanged() {},
    async cleanup() {}
  };
}
