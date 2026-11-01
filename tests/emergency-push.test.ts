import { describe, expect, it } from "vitest";
import type { Logger } from "../src/diagnostics/logger";
import { TransactionalSyncExecutor } from "../src/execution/executor";
import type { LocalTransactionalMutator } from "../src/execution/local-mutator";
import type { RemoteTransactionalMutator, RemoteTransferResult } from "../src/execution/remote-mutator";
import { makeEmergencyPushPlan } from "../src/planner/emergency-push";
import { SyncPlanner } from "../src/planner/planner";
import { sha256Hex } from "../src/state/durable/crypto";
import type { FileReplicaRecord } from "../src/state/durable/model";
import { DurableStateStore } from "../src/state/durable/store";
import type { TransferTuning } from "../src/transfer/types";
import { MemoryStateBackend } from "./helpers/memory-backend";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const tuning: TransferTuning = { chunkUploadThresholdBytes: 5 * 1024 * 1024, uploadChunkBytes: 5 * 1024 * 1024, downloadRangeChunkBytes: 1024 * 1024, maxWholeDownloadBytes: 5 * 1024 * 1024 };
const H = (c: string): string => c.repeat(64);

type Seed = Pick<FileReplicaRecord, "entryId" | "path" | "baseline" | "local" | "remote" | "status">;
const local = (path: string, hash: string, mtimeMs = 10_000) => ({ path, contentHash: hash, size: 3, mtimeMs });
const remote = (path: string, hash: string | null, fileId: string, mtimeMs = 10_000) => ({ path, contentHash: hash, reportedSha256: null, etag: `"e${fileId}"`, fileId, size: 3, mtimeMs });

async function seeded(records: Seed[]): Promise<DurableStateStore> {
  const store = await DurableStateStore.open(new MemoryStateBackend(), logger);
  await store.transact("seed", (tx) => { for (const record of records) tx.putFile(record); });
  return store;
}

describe("Emergency upload planning", () => {
  it("uploads what Nextcloud lacks or holds in an older version, and never plans a deletion or download", async () => {
    const store = await seeded([
      // The wiped-Nextcloud case: this device has the file, Nextcloud no longer does.
      { entryId: "file_wiped", path: "A.md", baseline: null, local: local("A.md", H("a")), remote: null, status: "local-dirty" },
      { entryId: "file_same", path: "B.md", baseline: null, local: local("B.md", H("b")), remote: remote("B.md", H("b"), "2"), status: "both-dirty" },
      { entryId: "file_older", path: "C.md", baseline: null, local: local("C.md", H("c"), 50_000), remote: remote("C.md", H("d"), "3", 10_000), status: "both-dirty" },
      { entryId: "file_newer", path: "D.md", baseline: null, local: local("D.md", H("e"), 10_000), remote: remote("D.md", H("f"), "4", 90_000), status: "both-dirty" },
      { entryId: "file_unknown", path: "E.md", baseline: null, local: local("E.md", H("1")), remote: remote("E.md", null, "5"), status: "both-dirty" },
      { entryId: "file_remoteonly", path: "F.md", baseline: null, local: null, remote: remote("F.md", H("2"), "6"), status: "remote-dirty" }
    ]);
    const plan = await new SyncPlanner().build(store.getState());
    const { plan: push, stats } = await makeEmergencyPushPlan(plan, store.getState(), { limit: 100 });
    expect(stats).toEqual({ create: 1, update: 1, verifying: 1, same: 1, deferred: 1, remoteOnly: 1 });
    const byPath = new Map(push.items.map((item) => [item.displayPath, item.steps.map((step) => step.kind)]));
    expect(byPath.get("A.md")).toEqual(["upload-create", "establish-baseline"]);
    expect(byPath.get("C.md")).toEqual(["upload-update", "establish-baseline"]);
    expect(byPath.get("E.md")).toEqual(["verify-remote-content"]);
    expect(byPath.get("B.md")).toEqual(["establish-baseline"]);
    expect(byPath.has("D.md")).toBe(false); // Nextcloud is clearly newer: left to the normal sync, which keeps both
    expect(byPath.has("F.md")).toBe(false);
    const kinds = push.items.flatMap((item) => item.steps.map((step) => step.kind));
    expect(kinds.some((kind) => kind.startsWith("delete") || kind.startsWith("download") || kind === "manual-resolution")).toBe(false);
    expect(push.items.every((item) => item.steps.every((step) => !step.destructive))).toBe(true);
  });

  it("caps a round and skips files that already failed", async () => {
    const records: Seed[] = Array.from({ length: 5 }, (_, index) => ({
      entryId: `file_item${index}`, path: `N${index}.md`, baseline: null, local: local(`N${index}.md`, H(String(index))), remote: null, status: "local-dirty" as const
    }));
    const store = await seeded(records);
    const plan = await new SyncPlanner().build(store.getState());
    const first = await makeEmergencyPushPlan(plan, store.getState(), { limit: 2 });
    expect(first.plan.items).toHaveLength(2);
    const skipped = await makeEmergencyPushPlan(plan, store.getState(), { limit: 10, skip: new Set(["file_item0", "file_item1"]) });
    expect(skipped.plan.items.map((item) => item.entryId)).toEqual(["file_item2", "file_item3", "file_item4"]);
  });

  it("runs through the executor in emergency mode: uploads and replaces, never deletes or downloads", async () => {
    const bytes = new TextEncoder().encode("abc").buffer;
    const hash = await sha256Hex(bytes);
    const store = await seeded([
      { entryId: "file_new", path: "New.md", baseline: null, local: local("New.md", hash), remote: null, status: "local-dirty" },
      { entryId: "file_old", path: "Old.md", baseline: null, local: local("Old.md", hash, 60_000), remote: remote("Old.md", H("9"), "7", 1_000), status: "both-dirty" }
    ]);
    const plan = await new SyncPlanner().build(store.getState());
    const { plan: push } = await makeEmergencyPushPlan(plan, store.getState(), { limit: 10 });

    const snapshot = (path: string) => ({
      snapshotId: "s", path, contentHash: hash, size: bytes.byteLength, mtimeMs: 60_000, chunkSize: 3, chunkCount: 1,
      async readChunk() { return bytes.slice(0); }, async *chunks() { yield bytes.slice(0); }, async assertSourceUnchanged() {}, async cleanup() {}
    });
    const uploaded: string[] = [];
    const result = (path: string, id: string): RemoteTransferResult => ({ contentHash: hash, remote: remote(path, hash, id), chunked: false, resumed: false });
    const localPort = { async prepareSnapshot(path: string) { return snapshot(path); } } as unknown as LocalTransactionalMutator;
    const remotePort = {
      async ensureParentDirectories() {},
      async uploadCreateFromSnapshot(_url: string, path: string) { uploaded.push(`create ${path}`); return result(path, "11"); },
      async uploadUpdateFromSnapshot(_url: string, path: string) { uploaded.push(`update ${path}`); return result(path, "7"); },
      async remove() { throw new Error("an emergency upload must never delete"); },
      async openDownload() { throw new Error("an emergency upload must never download"); }
    } as unknown as RemoteTransactionalMutator;
    const executor = new TransactionalSyncExecutor(store, localPort, remotePort, "https://cloud.example.test/remote.php/dav/files/u/", "Obsidian", tuning, logger);
    const report = await executor.execute(push, { allowDestructive: false, allowMerge: false, maxOperations: 20, mode: "emergency-push" });
    expect(report.failed).toBe(0);
    expect(uploaded.sort()).toEqual(["create New.md", "update Old.md"]);
    expect(store.getState().files.file_new?.status).toBe("clean");
    expect(store.getState().files.file_old?.baseline?.blobHash).toBe(hash);
  });
});
