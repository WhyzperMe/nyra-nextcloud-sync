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

describe("Transactional executor", () => {
  it("uploads from a fenced snapshot and establishes an immutable chunk-written baseline", async () => {
    const store = await DurableStateStore.open(new MemoryStateBackend(), logger);
    const bytes = new TextEncoder().encode("stage7\n").buffer;
    const hash = await sha256Hex(bytes);
    await store.transact("seed-local-create", (tx) => tx.putFile({
      entryId: "file_stage7",
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
    const remote = {
      async ensureParentDirectories() {},
      async uploadCreateFromSnapshot(): Promise<RemoteTransferResult> {
        return { contentHash: hash, remote: remoteState, chunked: false, resumed: false };
      }
    } as unknown as RemoteTransactionalMutator;

    const executor = new TransactionalSyncExecutor(
      store, local, remote, "https://cloud.example.test/remote.php/dav/files/u/", "Obsidian", tuning, logger
    );
    const report = await executor.execute(plan, { allowDestructive: false, allowMerge: false, maxOperations: 20 });
    expect(report.failed).toBe(0);
    expect(report.completed).toBe(2);
    expect(report.bytesProcessed).toBe(bytes.byteLength);
    const record = store.getState().files.file_stage7;
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
      tombstoneId: "tomb_stage7",
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
